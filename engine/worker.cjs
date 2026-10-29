"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const jpeg = require("jpeg-js");
const { PointTracker } = require("./tracker.cjs");
const { aspectRatio, missingRanges } = require("../core.cjs");

let decoder = null;
let cancelled = false;
const emit = data => { if (process.connected) process.send(data); };

function finish(message) {
  if (!process.connected) return;
  // A preview can exceed the IPC pipe buffer. Keep the channel alive until
  // Node has flushed the final response, including when the parent is CEP.
  function flushed(error) {
    if (error) { console.error("Falha ao enviar o resultado do processamento: " + error.message); process.exitCode = 1; }
    if (process.connected) process.disconnect();
  }
  try { process.send(message, flushed); }
  catch (error) { flushed(error); }
}

function binaryOutput(file, args, maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, shell: false });
    decoder = child;
    const chunks = [];
    let length = 0, errors = "";
    child.stdout.on("data", chunk => {
      length += chunk.length;
      if (length > maxBytes) { child.kill(); reject(new Error("Resposta de mídia grande demais.")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-4000); });
    child.on("error", reject);
    child.on("close", code => {
      if (decoder === child) decoder = null;
      if (cancelled) reject(new Error("Análise cancelada."));
      else if (code !== 0) reject(new Error(errors || "Não foi possível ler a mídia."));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function probe(config, file) {
  const output = await binaryOutput(config.ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation:format=duration", "-of", "json", file]);
  const metadata = JSON.parse(output.toString("utf8"));
  const stream = metadata.streams && metadata.streams[0];
  if (!stream) throw new Error("A mídia não contém vídeo legível.");
  const displayMatrix = (stream.side_data_list || []).find(s => s.rotation !== undefined);
  const angle = Number(displayMatrix ? displayMatrix.rotation : stream.tags && stream.tags.rotate || 0);
  if (!Number.isFinite(angle)) throw new Error("A mídia informou uma rotação de metadados inválida.");
  const normalizedAngle = (angle % 360 + 360) % 360;
  const rotation = Math.round(normalizedAngle / 90) % 4 * 90;
  const deviation = Math.abs(normalizedAngle - rotation);
  if (Math.min(deviation, 360 - deviation) > 0.1) throw new Error("A orientação de metadados deste vídeo (" + angle + "°) ainda não é suportada pelo tracker. O arquivo original foi preservado.");
  const encodedPixelAspectRatio = [undefined, "N/A", "0:1"].includes(stream.sample_aspect_ratio) ? 1 : aspectRatio(stream.sample_aspect_ratio);
  const quarterTurn = rotation === 90 || rotation === 270;
  // FFmpeg autorotates by default, before our fps/scale filters. Keep every
  // preview, tracking sample and application dimension in that upright space;
  // a quarter turn also swaps the pixel axes, so SAR must be inverted once.
  const pixelAspectRatio = quarterTurn ? 1 / encodedPixelAspectRatio : encodedPixelAspectRatio;
  const [num, den] = (stream.avg_frame_rate || "0/0").split("/").map(Number);
  if (!(stream.width > 0 && stream.height > 0)) throw new Error("A mídia não informou dimensões válidas.");
  const stat = fs.statSync(file);
  return { width: quarterTurn ? stream.height : stream.width, height: quarterTurn ? stream.width : stream.height, encodedWidth: stream.width, encodedHeight: stream.height, encodedPixelAspectRatio, rotation, pixelAspectRatio, fps: Number.isFinite(num / den) ? num / den : null, duration: Number(metadata.format.duration) || null, revision: stat.size + ":" + stat.mtimeMs };
}

function sizeFor(metadata) {
  const displayWidth = metadata.width * (metadata.pixelAspectRatio || 1);
  const factor = Math.min(1, 960 / Math.max(displayWidth, metadata.height));
  return { width: Math.max(2, Math.round(displayWidth * factor / 2) * 2), height: Math.max(2, Math.round(metadata.height * factor / 2) * 2) };
}

function preview(rgb, width, height) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i]; rgba[j + 1] = rgb[i + 1]; rgba[j + 2] = rgb[i + 2]; rgba[j + 3] = 255;
  }
  return jpeg.encode({ data: rgba, width, height }, 65).data.toString("base64");
}

function validateJob(job) {
  if (!job || !job.config || ![job.config.ffmpeg, job.config.ffprobe, job.file].every(x => typeof x === "string" && fs.existsSync(x))) throw new Error("Configure Node/FFmpeg no instalador e carregue uma mídia válida.");
  if (!["probe", "frame", "track", "audio"].includes(job.type)) throw new Error("Operação de mídia inválida.");
  if (job.type === "probe") return;
  for (const key of ["inSeconds", "duration", "fps", "referenceFrame"]) {
    if (typeof job[key] !== "number" || !Number.isFinite(job[key])) throw new Error("Tempos/fps inválidos: " + key);
  }
  const totalFrames = Math.ceil(job.duration * job.fps - 0.00001);
  if (job.inSeconds < 0 || job.duration <= 0 || job.duration > 60.01 || job.fps < 1 || job.fps > 120 || !Number.isInteger(job.referenceFrame) || job.referenceFrame < 0 || job.referenceFrame >= totalFrames) throw new Error("Use até 60 segundos, entre 1 e 120 fps, com referência dentro do clipe.");
  if (totalFrames > 3600) throw new Error("Este trecho ultrapassa o limite de 3.600 frames. Divida o clipe primeiro.");
  if (job.type === "track") {
    const range = jobRange(job);
    if (range.endFrame <= range.startFrame || job.referenceFrame < range.startFrame || job.referenceFrame > range.endFrame) throw new Error("Escolha In/Out com pelo menos dois frames e referência dentro do intervalo.");
    if (!job.point || ![job.point.x, job.point.y, job.radius].every(Number.isFinite) || job.point.x <= 0 || job.point.x >= 1 || job.point.y <= 0 || job.point.y >= 1 || job.radius < 12 || job.radius > 80) throw new Error("Selecione um ponto e uma área de busca válida.");
    if (job.confidenceThreshold !== undefined && (!Number.isFinite(job.confidenceThreshold) || job.confidenceThreshold < 0.1 || job.confidenceThreshold > 0.95)) throw new Error("Limite de confiança inválido.");
    if (job.lostTolerance !== undefined && (!Number.isInteger(job.lostTolerance) || job.lostTolerance < 0 || job.lostTolerance > 30)) throw new Error("Tolerância de frames perdidos inválida.");
  }
}

function jobRange(job) {
  const totalFrames = Math.ceil(job.duration * job.fps - 0.00001);
  const startFrame = job.startFrame === undefined ? 0 : job.startFrame;
  const endFrame = job.endFrame === undefined ? totalFrames - 1 : job.endFrame;
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < 0 || endFrame < startFrame || endFrame >= totalFrames) throw new Error("Intervalo In/Out inválido.");
  return { startFrame, endFrame };
}

function rawArgs(job, size, startFrame, count) {
  return ["-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-ss", String(job.inSeconds + startFrame / job.fps), "-i", job.file,
    "-an", "-sn", "-vf", `fps=${job.fps}:start_time=0:round=near,scale=${size.width}:${size.height}`, "-frames:v", String(count), "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"];
}

// Forward frames stream. Reverse frames are decoded in small independent
// batches, rather than FFmpeg's reverse filter (which buffers the entire clip).
async function* decodedFrames(job, size, fromFrame, toFrame, direction) {
  const frameBytes = size.width * size.height * 3;
  if (direction < 0) {
    const batchFrames = Math.max(1, Math.min(16, Math.floor(32 * 1024 * 1024 / frameBytes)));
    for (let last = fromFrame; last >= toFrame; last -= batchFrames) {
      if (cancelled) throw new Error("Análise cancelada.");
      const first = Math.max(toFrame, last - batchFrames + 1), count = last - first + 1;
      const buffer = await binaryOutput(job.config.ffmpeg, rawArgs(job, size, first, count), frameBytes * count);
      if (buffer.length !== frameBytes * count) throw new Error("A mídia terminou antes do intervalo selecionado. Verifique duração e ponto de entrada.");
      for (let frame = last; frame >= first; frame -= 1) yield { frame, rgb: buffer.subarray((frame - first) * frameBytes, (frame - first + 1) * frameBytes) };
    }
    return;
  }
  const count = toFrame - fromFrame + 1;
  const child = spawn(job.config.ffmpeg, rawArgs(job, size, fromFrame, count), { windowsHide: true, shell: false });
  decoder = child;
  let errors = "", pending = Buffer.alloc(0), frame = fromFrame;
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => { if (!cancelled && code !== 0) reject(new Error(errors || "FFmpeg encerrou durante a leitura.")); else resolve(); });
  });
  completion.catch(() => {});
  child.stderr.on("data", chunk => { errors = (errors + chunk.toString()).slice(-3000); });
  try {
    for await (const chunk of child.stdout) {
      if (cancelled) throw new Error("Análise cancelada.");
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        yield { frame, rgb: pending.subarray(0, frameBytes) };
        pending = pending.subarray(frameBytes);
        frame += 1;
      }
    }
    await completion;
    if (cancelled) throw new Error("Análise cancelada.");
    if (frame !== toFrame + 1 || pending.length) throw new Error("A mídia terminou antes do intervalo selecionado. Verifique duração e ponto de entrada.");
  } finally {
    child.kill();
    if (decoder === child) decoder = null;
    await completion.catch(() => {});
  }
}

async function track(job, metadata, size) {
  const cv = await require("@techstark/opencv-js");
  if (cancelled) throw new Error("Análise cancelada.");
  const range = jobRange(job), totalFrames = Math.ceil(job.duration * job.fps - 0.00001);
  const samples = new Map(), failures = [], tolerance = job.lostTolerance || 0;
  const point = { x: job.point.x * size.width, y: job.point.y * size.height };
  let processed = 0;
  async function branch(direction, endFrame) {
    const tracker = new PointTracker(cv, size.width, size.height, point, job.radius, { confidenceThreshold: job.confidenceThreshold });
    const rgbMat = new cv.Mat(size.height, size.width, cv.CV_8UC3), gray = new cv.Mat();
    let first = true, missed = 0;
    try {
      for await (const frame of decodedFrames(job, size, job.referenceFrame, endFrame, direction)) {
        if (cancelled) throw new Error("Análise cancelada.");
        rgbMat.data.set(frame.rgb);
        cv.cvtColor(rgbMat, gray, cv.COLOR_RGB2GRAY);
        const step = first ? tracker.start(gray) : tracker.step(gray);
        first = false;
        // Tolerance permits reacquisition, not fake/held positions. Every
        // failed frame remains absent and blocks application until repaired.
        if (step.lost) {
          missed += 1;
          failures.push({ frame: frame.frame, direction });
          if (missed > tolerance) break;
        } else {
          missed = 0;
          samples.set(frame.frame, { frame: frame.frame, x: step.x / size.width, y: step.y / size.height, confidence: step.confidence });
        }
        processed += frame.frame === job.referenceFrame && direction < 0 ? 0 : 1;
        if (processed % Math.max(3, Math.round(job.fps / 7)) === 0 || frame.frame === endFrame) emit({ type: "progress", frame: frame.frame, direction, progress: Math.min(1, processed / (range.endFrame - range.startFrame + 1)), point: { x: step.x / size.width, y: step.y / size.height }, confidence: step.confidence, lost: !!step.lost, image: preview(frame.rgb, size.width, size.height) });
        // Let cancellation messages run between synchronous OpenCV frames.
        await new Promise(resolve => setImmediate(resolve));
      }
    } finally { tracker.dispose(); rgbMat.delete(); gray.delete(); }
  }
  await branch(1, range.endFrame);
  if (job.referenceFrame > range.startFrame) await branch(-1, range.startFrame);
  const ordered = Array.from(samples.values()).sort((a, b) => a.frame - b.frame);
  const missing = missingRanges(ordered, range);
  return { schema: 2, fps: job.fps, totalFrames, range, referenceFrame: job.referenceFrame, source: { ...metadata, file: job.file, inSeconds: job.inSeconds, duration: job.duration, fps: job.fps }, samples: ordered, missing, failures, lost: !!missing.length, truncated: !!missing.length, width: size.width, height: size.height };
}

function pcmWaveform(buffer, bins = 640) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") throw new Error("Áudio de preview inválido.");
  let format, data;
  for (let position = 12; position + 8 <= buffer.length;) {
    const type = buffer.toString("ascii", position, position + 4), length = buffer.readUInt32LE(position + 4), start = position + 8;
    if (start + length > buffer.length) throw new Error("Áudio de preview truncado.");
    if (type === "fmt " && length >= 16) format = { code: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), bits: buffer.readUInt16LE(start + 14) };
    if (type === "data") data = buffer.subarray(start, start + length);
    position = start + length + (length % 2);
  }
  if (!format || format.code !== 1 || format.channels !== 1 || format.bits !== 16 || !format.sampleRate || !data || data.length % 2) throw new Error("Formato de áudio de preview inválido.");
  const sampleCount = data.length / 2;
  bins = Math.max(1, Math.min(2048, Math.round(bins)));
  const waveform = new Array(bins).fill(0);
  for (let i = 0; i < sampleCount; i += 1) {
    const bin = Math.min(bins - 1, Math.floor(i * bins / Math.max(1, sampleCount)));
    waveform[bin] = Math.max(waveform[bin], Math.abs(data.readInt16LE(i * 2)) / 32768);
  }
  return { waveform, sampleRate: format.sampleRate, duration: sampleCount / format.sampleRate };
}

function removeOwnedCache(cacheDir) {
  // This helper is only called for the exact freshly-created private directory,
  // never for a path received from a panel/job or for arbitrary temp contents.
  for (const name of ["audio.wav", "preview.mp4"]) {
    const file = path.join(cacheDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  fs.rmdirSync(cacheDir);
}

async function audioPreview(job, metadata) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-preview-"));
  const audioFile = path.join(cacheDir, "audio.wav"), videoFile = path.join(cacheDir, "preview.mp4");
  try {
    const raw = await binaryOutput(job.config.ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "json", job.file]);
    const hasAudio = !!(JSON.parse(raw.toString("utf8")).streams || []).length;
    let audio = { waveform: [], sampleRate: null, duration: job.duration }, audioError = null, proxyError = null;
    if (hasAudio) {
      try {
        await binaryOutput(job.config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-threads", "2", "-ss", String(job.inSeconds), "-i", job.file, "-t", String(job.duration), "-map", "0:a:0", "-vn", "-sn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", "-n", audioFile]);
        if (fs.statSync(audioFile).size > 6 * 1024 * 1024) throw new Error("Áudio de preview excedeu o limite local.");
        audio = pcmWaveform(fs.readFileSync(audioFile));
      } catch (error) {
        if (cancelled) throw error;
        audioError = error.message;
        if (fs.existsSync(audioFile)) fs.unlinkSync(audioFile);
      }
    }
    if (job.videoProxy !== false) {
      try {
        // A small local proxy enables synchronized audiovisual playback inside
        // CEP; original source files remain read-only and are never uploaded.
        const size = sizeFor(metadata);
        const ratio = Math.min(1, 640 / Math.max(size.width, size.height));
        const width = Math.max(2, Math.round(size.width * ratio / 2) * 2), height = Math.max(2, Math.round(size.height * ratio / 2) * 2);
        await binaryOutput(job.config.ffmpeg, ["-hide_banner", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-ss", String(job.inSeconds), "-i", job.file, "-t", String(job.duration), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-vf", `fps=${job.fps}:start_time=0:round=near,scale=${width}:${height},setsar=1`, "-c:v", "libx264", "-threads:v", "2", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", "-fs", String(128 * 1024 * 1024), "-n", videoFile]);
        if (fs.statSync(videoFile).size >= 128 * 1024 * 1024) throw new Error("Proxy de vídeo excedeu o limite local.");
      } catch (error) {
        if (cancelled) throw error;
        proxyError = error.message;
        if (fs.existsSync(videoFile)) fs.unlinkSync(videoFile);
      }
    }
    return { cacheDir, audioFile: fs.existsSync(audioFile) ? audioFile : null, videoFile: fs.existsSync(videoFile) ? videoFile : null, hasAudio, audioError, proxyError, ...audio };
  } catch (error) { removeOwnedCache(cacheDir); throw error; }
}

async function run(job) {
  validateJob(job);
  const metadata = await probe(job.config, job.file);
  if (job.type === "probe") return metadata;
  if (job.type === "audio") return audioPreview(job, metadata);
  const size = sizeFor(metadata);
  if (job.type === "track") return track(job, metadata, size);
  const frame = await binaryOutput(job.config.ffmpeg, rawArgs(job, size, job.referenceFrame, 1));
  if (frame.length !== size.width * size.height * 3) throw new Error("Não foi possível ler o frame selecionado.");
  return { ...metadata, previewWidth: size.width, previewHeight: size.height, image: preview(frame, size.width, size.height) };
}

if (require.main === module) {
  let acceptedJob = false;
  process.on("message", async job => {
    if (job && job.type === "cancel") { cancelled = true; if (decoder) decoder.kill(); return; }
    // A worker owns one media job. Unexpected duplicate IPC cannot start a
    // second decoder or steal the cancellation handle from the first one.
    if (acceptedJob) return;
    acceptedJob = true;
    let response;
    try { const result = await run(job); response = { type: "done", result }; }
    catch (error) { response = { type: "error", message: error.message }; }
    finish(response);
  });
  process.on("disconnect", () => { cancelled = true; if (decoder) decoder.kill(); });
}

module.exports = { run, probe, sizeFor, validateJob, jobRange, pcmWaveform };
