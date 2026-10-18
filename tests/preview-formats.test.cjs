"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync, fork } = require("node:child_process");
const { run } = require("../engine/worker.cjs");
const jpeg = require("jpeg-js");
const ffmpeg = process.env.PONTO_FFMPEG || "C:\\Program Files\\Shutter Encoder\\app\\Library\\ffmpeg.exe";
const ffprobe = process.env.PONTO_FFPROBE || path.join(path.dirname(ffmpeg), "ffprobe.exe");
const available = fs.existsSync(ffmpeg) && fs.existsSync(ffprobe);
const variants = [
  { name: "H.264 29.97 with fractional trim and Unicode, spaces and symbols in path", filename: "Ação 100% & câmera #1.mp4", rate: "30000/1001", size: "128x72", length: 1.3, codec: ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], inSeconds: 0.21, duration: 0.87, fps: 30000 / 1001 },
  { name: "4K 59.94 source downscales into a bounded preview", filename: "4k.mp4", rate: "60000/1001", size: "3840x2160", length: 0.2, codec: ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], inSeconds: 0, duration: 0.18, fps: 60000 / 1001 },
  { name: "ProRes 422 MOV", filename: "prores.mov", rate: "25", size: "128x72", length: 0.5, codec: ["-c:v", "prores_ks", "-profile:v", "2", "-pix_fmt", "yuv422p10le"], inSeconds: 0.08, duration: 0.32, fps: 25 },
  { name: "MPEG-2 MXF", filename: "camera.mxf", rate: "25", size: "320x180", length: 0.5, codec: ["-c:v", "mpeg2video", "-b:v", "5000k", "-pix_fmt", "yuv422p"], inSeconds: 0.04, duration: 0.32, fps: 25 },
  { name: "anamorphic source preserves display aspect ratio", filename: "wide.mov", rate: "24", size: "128x72", length: 0.5, filters: "setsar=4/3", codec: ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"], inSeconds: 0, duration: 0.4, fps: 24 },
  { name: "MPEG-TS source with nonzero container start timestamp", filename: "camera.ts", rate: "30", size: "128x72", length: 0.5, codec: ["-c:v", "mpeg2video", "-muxdelay", "0.7"], inSeconds: 0, duration: 0.4, fps: 30 },
];
for (const variant of variants) test("Frame preview: " + variant.name, { skip: !available, timeout: 20000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-format-test-"));
  const file = path.join(folder, variant.filename);
  try {
    const args = ["-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-f", "lavfi", "-i", `testsrc2=size=${variant.size}:rate=${variant.rate}:duration=${variant.length}`, "-an"];
    if (variant.filters) args.push("-vf", variant.filters);
    args.push(...variant.codec, file);
    const encoded = spawnSync(ffmpeg, args, { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const job = { type: "frame", config: { ffmpeg, ffprobe }, file, inSeconds: variant.inSeconds, duration: variant.duration, fps: variant.fps };
    for (const referenceFrame of [0, Math.ceil(variant.duration * variant.fps - 0.00001) - 1]) {
      const result = await run({ ...job, referenceFrame });
      assert.ok(result.image.length > 100, "actual JPEG image was decoded");
      assert.equal(Buffer.from(result.image, "base64").subarray(0, 2).toString("hex"), "ffd8");
      assert.ok(Math.max(result.previewWidth, result.previewHeight) <= 960);
    }
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});

function command(args, options) {
  const result = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", ...args], { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024, ...options });
  assert.equal(result.status, 0, String(result.stderr));
  return result;
}
function rotatedFixture(folder, angle, sar = "1/1") {
  const encoded = path.join(folder, "encoded.mp4"), file = path.join(folder, "oriented.mp4");
  const rgb = Buffer.alloc(128 * 72 * 3), colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  for (let y = 0; y < 72; y += 1) for (let x = 0; x < 128; x += 1) {
    const i = (y * 128 + x) * 3, noise = (x * 19 + y * 31 + (x ^ y) * 17) & 255;
    const corner = x < 16 ? y < 16 ? 0 : y >= 56 ? 2 : -1 : x >= 112 ? y < 16 ? 1 : y >= 56 ? 3 : -1 : -1;
    const color = corner >= 0 ? colors[corner] : [noise, noise, noise];
    rgb[i] = color[0]; rgb[i + 1] = color[1]; rgb[i + 2] = color[2];
  }
  command(["-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "128x72", "-r", "30", "-i", "pipe:0", "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=44100:duration=0.4", "-vf", "setsar=" + sar, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "12", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", encoded], { input: Buffer.concat(new Array(12).fill(rgb)) });
  command(["-display_rotation:v:0", String(angle), "-i", encoded, "-c", "copy", file]);
  return { file, encoded, colors };
}
function assertUprightCorners(base64, order, colors) {
  const image = jpeg.decode(Buffer.from(base64, "base64"));
  const points = [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94]];
  points.forEach(([x, y], index) => {
    const offset = (Math.floor(y * image.height) * image.width + Math.floor(x * image.width)) * 4;
    const actual = Array.from(image.data.subarray(offset, offset + 3));
    assert.ok(Math.hypot(...actual.map((v, i) => v - colors[order[index]][i])) < 65, "correct single rotation at corner " + index + ": " + actual);
  });
}
function removePreview(result) {
  if (!result) return;
  assert.equal(path.dirname(result.cacheDir), os.tmpdir().replace(/[\\/]$/, ""));
  assert.match(path.basename(result.cacheDir), /^fasttracker-preview-/);
  for (const name of ["audio.wav", "preview.mp4"]) {
    const file = path.join(result.cacheDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(result.cacheDir);
}
for (const rotation of [
  { angle: 90, order: [1, 3, 0, 2], width: 72, height: 128, sar: "1/1", par: 1 },
  { angle: -90, order: [2, 0, 3, 1], width: 72, height: 128, sar: "1/1", par: 1 },
  { angle: 180, order: [3, 2, 1, 0], width: 128, height: 72, sar: "1/1", par: 1 },
  { angle: 90, order: [1, 3, 0, 2], width: 72, height: 128, sar: "4/3", par: 0.75 }
]) test("Metadata rotation " + rotation.angle + "° / encoded SAR " + rotation.sar + " is upright exactly once for frame, tracking and audiovisual proxy", { skip: !available, timeout: 20000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-orientation-test-"));
  let fixture, audio;
  try {
    fixture = rotatedFixture(folder, rotation.angle, rotation.sar);
    const job = { config: { ffmpeg, ffprobe }, file: fixture.file, inSeconds: 0, duration: 0.4, fps: 30, referenceFrame: 0 };
    const metadata = await run({ ...job, type: "probe" });
    assert.equal(metadata.rotation, (rotation.angle + 360) % 360);
    assert.equal(metadata.width, rotation.width); assert.equal(metadata.height, rotation.height);
    assert.equal(metadata.encodedWidth, 128); assert.equal(metadata.encodedHeight, 72);
    assert.equal(metadata.pixelAspectRatio, rotation.par);
    assert.equal(metadata.encodedPixelAspectRatio, rotation.sar === "4/3" ? 4 / 3 : 1);
    const frame = await run({ ...job, type: "frame" });
    assert.equal(frame.previewWidth, Math.round(rotation.width * rotation.par / 2) * 2); assert.equal(frame.previewHeight, rotation.height);
    assertUprightCorners(frame.image, rotation.order, fixture.colors);
    const tracked = await run({ ...job, type: "track", point: { x: 0.5, y: 0.5 }, radius: 12, confidenceThreshold: 0.3 });
    assert.equal(tracked.lost, false); assert.equal(tracked.samples.length, 12);
    assert.equal(tracked.source.width, metadata.width); assert.equal(tracked.source.height, metadata.height);
    assert.equal(tracked.source.rotation, metadata.rotation); assert.equal(tracked.source.pixelAspectRatio, metadata.pixelAspectRatio);
    assert.ok(tracked.samples.every(sample => Math.hypot(sample.x - 0.5, sample.y - 0.5) < 0.001));
    audio = await run({ ...job, type: "audio" });
    assert.equal(audio.audioError, null); assert.equal(audio.proxyError, null); assert.equal(audio.hasAudio, true);
    assert.ok(audio.waveform.some(peak => peak > 0.05)); assert.ok(Math.abs(audio.duration - 0.4) < 0.03, "real waveform duration accounts for AAC encoder padding: " + audio.duration);
    const proxy = await run({ ...job, type: "frame", file: audio.videoFile });
    assert.equal(proxy.rotation, 0); assert.equal(proxy.width, frame.previewWidth); assert.equal(proxy.height, frame.previewHeight); assert.equal(proxy.pixelAspectRatio, 1);
    assertUprightCorners(proxy.image, rotation.order, fixture.colors);
  } finally {
    removePreview(audio);
    for (const name of ["encoded.mp4", "oriented.mp4"]) { const file = path.join(folder, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
    fs.rmdirSync(folder);
  }
});

test("Non-quarter metadata rotation reports its actual unsupported orientation without modifying source", { skip: !available, timeout: 20000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-odd-orientation-test-"));
  try {
    const fixture = rotatedFixture(folder, 45), before = fs.statSync(fixture.file);
    await assert.rejects(run({ type: "probe", config: { ffmpeg, ffprobe }, file: fixture.file }), /orientação.*45°.*não é suportada/);
    const after = fs.statSync(fixture.file); assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
  } finally {
    for (const name of ["encoded.mp4", "oriented.mp4"]) { const file = path.join(folder, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
    fs.rmdirSync(folder);
  }
});

test("An actual forked worker returns a decodable upright preview over IPC for a rotated source", { skip: !available, timeout: 20000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-orientation-ipc-test-"));
  let child;
  try {
    const fixture = rotatedFixture(folder, 90);
    child = fork(path.join(__dirname, "../engine/worker.cjs"), [], { silent: true, windowsHide: true });
    child.stdout.resume();
    let errors = "";
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-2000); });
    const completed = new Promise((resolve, reject) => {
      let result, workerError;
      const timer = setTimeout(() => { child.kill(); reject(new Error("Real media worker did not finish within 12 seconds.")); }, 12000);
      child.on("message", message => {
        if (message.type === "done") result = message.result;
        if (message.type === "error") workerError = new Error(message.message);
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); if (workerError) reject(workerError); else if (!result) reject(new Error(errors || "Worker exited without returning the actual preview.")); else resolve(result); });
    });
    child.send({ type: "frame", config: { ffmpeg, ffprobe }, file: fixture.file, inSeconds: 0, duration: 0.4, fps: 30, referenceFrame: 0 });
    const result = await completed;
    assert.equal(result.width, 72); assert.equal(result.height, 128); assert.equal(result.rotation, 90);
    assert.equal(result.previewWidth, 72); assert.equal(result.previewHeight, 128);
    assertUprightCorners(result.image, [1, 3, 0, 2], fixture.colors);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    for (const name of ["encoded.mp4", "oriented.mp4"]) { const file = path.join(folder, name); if (fs.existsSync(file)) fs.unlinkSync(file); }
    fs.rmdirSync(folder);
  }
});
