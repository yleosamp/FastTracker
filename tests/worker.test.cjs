"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), { spawnSync, fork } = require("node:child_process");
const vm = require("node:vm"), { EventEmitter } = require("node:events");
const { run, validateJob, jobRange, pcmWaveform } = require("../engine/worker.cjs");
const ffmpeg = process.env.PONTO_FFMPEG || "C:\\Program Files\\Shutter Encoder\\app\\Library\\ffmpeg.exe";
const ffprobe = process.env.PONTO_FFPROBE || path.join(path.dirname(ffmpeg), "ffprobe.exe");
const config = { ffmpeg, ffprobe }, available = fs.existsSync(ffmpeg) && fs.existsSync(ffprobe);
const validJob = { type: "track", config: { ffmpeg: __filename, ffprobe: __filename }, file: __filename, inSeconds: 0, duration: 1, fps: 30, referenceFrame: 15, point: { x: 0.5, y: 0.5 }, radius: 26 };
function removeCache(result) {
  assert.ok(path.basename(result.cacheDir).startsWith("fasttracker-preview-"));
  assert.equal(path.dirname(result.cacheDir), os.tmpdir().replace(/[\\/]$/, ""));
  for (const filename of ["audio.wav", "preview.mp4"]) { const file = path.join(result.cacheDir, filename); if (fs.existsSync(file)) fs.unlinkSync(file); }
  fs.rmdirSync(result.cacheDir);
}
test("Worker keeps IPC connected until its final response has flushed", async () => {
  const workerProcess = new EventEmitter(), entry = { exports: {} }, sent = [];
  let flush, disconnects = 0;
  workerProcess.connected = true;
  workerProcess.send = (message, callback) => { sent.push(message); flush = callback; };
  workerProcess.disconnect = () => { disconnects += 1; workerProcess.connected = false; workerProcess.emit("disconnect"); };
  const workerRequire = name => require(name.startsWith(".") ? path.resolve(__dirname, "../engine", name) : name);
  workerRequire.main = entry;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../engine/worker.cjs"), "utf8"), { require: workerRequire, module: entry, process: workerProcess, console });
  await workerProcess.listeners("message")[0]({ type: "invalid" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "error");
  assert.equal(typeof flush, "function", "the final send registers a flush callback");
  assert.equal(disconnects, 0, "a queued response keeps its IPC channel open");
  flush(null);
  assert.equal(disconnects, 1);
});

test("A real worker flushes a large JPEG preview before closing IPC", { skip: !available, timeout: 20000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-ipc-preview-")), file = path.join(folder, "textured.ppm");
  let child;
  try {
    const width = 960, height = 540, pixels = Buffer.alloc(width * height * 3);
    let seed = 123456789;
    for (let i = 0; i < pixels.length; i += 1) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24; }
    fs.writeFileSync(file, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
    child = fork(path.join(__dirname, "../engine/worker.cjs"), [], { silent: true, windowsHide: true });
    child.stdout.resume();
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    const messages = [], events = [];
    const completed = new Promise((resolve, reject) => {
      child.on("message", message => { messages.push(message); events.push("message"); });
      child.once("error", reject);
      child.once("close", (code, signal) => { events.push("close"); resolve({ code, signal }); });
    });
    child.send({ type: "frame", config, file, inSeconds: 0, duration: 1, fps: 25, referenceFrame: 0 });
    const closed = await completed;
    assert.deepEqual(closed, { code: 0, signal: null }, stderr);
    assert.equal(messages.length, 1, JSON.stringify(messages));
    assert.equal(messages[0].type, "done", JSON.stringify(messages[0]));
    assert.ok(messages[0].result.image.length > 100000, "the JPEG exceeds a typical IPC pipe buffer");
    const decoded = require("jpeg-js").decode(Buffer.from(messages[0].result.image, "base64"));
    assert.equal(decoded.width, width); assert.equal(decoded.height, height);
    assert.deepEqual(events, ["message", "close"]);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});
test("Tracking job bounds reject non-finite times, oversized work and references outside I/O", () => {
  assert.deepEqual(jobRange(validJob), { startFrame: 0, endFrame: 29 });
  validateJob(validJob);
  for (const change of [{ duration: 61 }, { fps: 121 }, { referenceFrame: 30 }, { startFrame: 16 }, { endFrame: 14 }, { startFrame: 2.1 }, { confidenceThreshold: 0.99 }, { lostTolerance: 31 }, { point: { x: NaN, y: 0.5 } }, { type: "whatever" }]) assert.throws(() => validateJob({ ...validJob, ...change }));
  validateJob({ ...validJob, startFrame: 15, endFrame: 29 });
  validateJob({ ...validJob, referenceFrame: 29 });
});
test("Waveform peaks come from actual PCM samples, including silence", () => {
  const values = [0, 0, 16384, -8192, -32768, 0, 0, 0], data = Buffer.alloc(values.length * 2);
  values.forEach((value, i) => data.writeInt16LE(value, i * 2));
  const wav = Buffer.alloc(44 + data.length);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8, 24); wav.writeUInt32LE(16, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(data.length, 40); data.copy(wav, 44);
  assert.deepEqual(pcmWaveform(wav, 4), { waveform: [0, 0.5, 1, 0], sampleRate: 8, duration: 1 });
  assert.throws(() => pcmWaveform(Buffer.from("not audio")), /inválido/);
  assert.throws(() => pcmWaveform(wav.subarray(0, -1)), /truncado/);
});
test("Local audiovisual preview is trimmed, decodable and has a real waveform", { skip: !available }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-av-test-")), file = path.join(folder, "fixture.mp4");
  let result;
  try {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=30:duration=2", "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=44100:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", file], { windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    result = await run({ type: "audio", config, file, inSeconds: 0.5, duration: 0.75, fps: 30, referenceFrame: 0 });
    assert.equal(result.hasAudio, true); assert.equal(result.audioError, null); assert.equal(result.proxyError, null);
    assert.ok(fs.existsSync(result.audioFile)); assert.ok(fs.existsSync(result.videoFile)); assert.equal(result.sampleRate, 22050);
    assert.equal(result.waveform.length, 640); assert.ok(result.waveform.some(peak => peak > 0.05)); assert.ok(Math.abs(result.duration - 0.75) < 0.01);
    const media = spawnSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", result.videoFile], { windowsHide: true });
    assert.equal(media.status, 0, String(media.stderr));
    const details = JSON.parse(media.stdout.toString());
    assert.ok(details.streams.some(stream => stream.codec_name === "h264")); assert.ok(details.streams.some(stream => stream.codec_name === "aac")); assert.ok(Math.abs(Number(details.format.duration) - 0.75) < 0.1);
  } finally { if (result) removeCache(result); if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(folder); }
});
test("Sources without audio return an honest empty waveform and still a video preview", { skip: !available }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-silent-test-")), file = path.join(folder, "silent.mp4");
  let result;
  try {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=64x36:rate=30:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-an", file], { windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    result = await run({ type: "audio", config, file, inSeconds: 0, duration: 1, fps: 30, referenceFrame: 0 });
    assert.equal(result.hasAudio, false); assert.equal(result.audioFile, null); assert.deepEqual(result.waveform, []); assert.equal(result.sampleRate, null);
    assert.ok(fs.existsSync(result.videoFile));
  } finally { if (result) removeCache(result); if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(folder); }
});

test("A real worker accepts cancellation and closes without returning invented partial success", { skip: !available, timeout: 10000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-cancel-test-")), file = path.join(folder, "fixture.mp4");
  let child;
  try {
    const rgb = Buffer.alloc(320 * 180 * 3);
    for (let y = 0; y < 180; y += 1) for (let x = 0; x < 320; x += 1) {
      const value = (x * 19 + y * 31 + (x ^ y) * 17) & 255, index = (y * 320 + x) * 3;
      rgb[index] = value; rgb[index + 1] = value; rgb[index + 2] = value;
    }
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "320x180", "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-an", file], { input: Buffer.concat(new Array(150).fill(rgb)), windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    child = fork(path.join(__dirname, "../engine/worker.cjs"), [], { silent: true, windowsHide: true });
    child.stdout.resume(); child.stderr.resume();
    const messages = [];
    const completed = new Promise((resolve, reject) => {
      child.on("message", message => { messages.push(message); if (message.type === "progress") child.send({ type: "cancel" }); });
      child.once("error", reject); child.once("exit", resolve);
    });
    child.send({ type: "track", config, file, inSeconds: 0, duration: 5, fps: 30, referenceFrame: 0, point: { x: 0.4, y: 0.5 }, radius: 32 });
    await completed;
    assert.ok(messages.some(message => message.type === "progress"), "real work reached its first progress event: " + JSON.stringify(messages));
    assert.ok(messages.some(message => message.type === "error" && /cancelada/.test(message.message)), "cancellation is acknowledged");
    assert.ok(!messages.some(message => message.type === "done"));
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill(); if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(folder); }
});
