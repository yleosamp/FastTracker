"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { PointTracker } = require("../engine/tracker.cjs");
const { run } = require("../engine/worker.cjs");
const { trackingOffsets } = require("../core.cjs");

const width = 320, height = 180, frames = 44;
const ffmpeg = process.env.PONTO_FFMPEG || "C:\\Program Files\\Shutter Encoder\\app\\Library\\ffmpeg.exe";
const ffprobe = process.env.PONTO_FFPROBE || path.join(path.dirname(ffmpeg), "ffprobe.exe");
function targetAt(i) { return { x: 80 + i * 2, y: 82 + Math.round(9 * Math.sin(i / 11)) }; }
function rgbFrame(i, blank = false) {
  const rgb = Buffer.alloc(width * height * 3);
  const center = targetAt(i);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const p = (y * width + x) * 3;
    let value = 24;
    const tx = x - center.x, ty = y - center.y;
    if (!blank && Math.abs(tx) <= 30 && Math.abs(ty) <= 30) {
      value = (((tx + 30) * 19 + (ty + 30) * 31 + ((tx + 30) ^ (ty + 30)) * 17) & 255);
    }
    rgb[p] = value; rgb[p + 1] = Math.min(255, value + 10); rgb[p + 2] = Math.max(0, value - 7);
  }
  return rgb;
}

test("Optical flow tracks a known translation, then refuses a vanished target", async () => {
  const cv = await require("@techstark/opencv-js");
  const rgb = new cv.Mat(height, width, cv.CV_8UC3), gray = new cv.Mat();
  const tracker = new PointTracker(cv, width, height, targetAt(0), 26);
  let maxError = 0;
  try {
    for (let i = 0; i < frames; i += 1) {
      rgb.data.set(rgbFrame(i)); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
      const sample = i === 0 ? tracker.start(gray) : tracker.step(gray);
      const truth = targetAt(i);
      assert.ok(!sample.lost, "lost at " + i);
      maxError = Math.max(maxError, Math.hypot(sample.x - truth.x, sample.y - truth.y));
    }
    assert.ok(maxError < 1.7, "max error " + maxError);
    rgb.data.set(rgbFrame(frames, true)); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    assert.equal(tracker.step(gray).lost, true);
    console.log("Known-motion max error:", maxError.toFixed(3), "px");
  } finally { tracker.dispose(); rgb.delete(); gray.delete(); }
});

test("A rejected feature refresh retains a consistent reference for reacquisition", async () => {
  const cv = await require("@techstark/opencv-js");
  const rgb = new cv.Mat(height, width, cv.CV_8UC3), gray = new cv.Mat();
  const tracker = new PointTracker(cv, width, height, targetAt(0), 26);
  try {
    rgb.data.set(rgbFrame(0)); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY); tracker.start(gray);
    const point = { ...tracker.point }, previous = tracker.previous, corners = tracker.points;
    const features = tracker.features;
    tracker.features = () => new cv.Mat();
    rgb.data.set(rgbFrame(1)); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    assert.equal(tracker.step(gray).lost, true);
    assert.deepEqual(tracker.point, point);
    assert.equal(tracker.previous, previous); assert.equal(tracker.points, corners);
    tracker.features = features;
    // Disable the independent template correction here so the optical-flow
    // state itself must recover without counting the rejected motion twice.
    tracker.match = () => null;
    rgb.data.set(rgbFrame(2)); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const recovered = tracker.step(gray), truth = targetAt(2);
    assert.equal(recovered.lost, false);
    assert.ok(Math.hypot(recovered.x - truth.x, recovered.y - truth.y) < 1,
      "reacquired point must not double-count motion from the rejected frame");
  } finally { tracker.dispose(); rgb.delete(); gray.delete(); }
});

test("H.264 encode/decode, nonzero source In, and mid-clip reference preserve motion", { skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ponto-test-"));
  const file = path.join(folder, "fixture.mp4");
  try {
    const video = Buffer.concat(Array.from({ length: frames }, (_, i) => rgbFrame(i)));
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-pix_fmt", "yuv420p", file], { input: video, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const ref = 4, sourceInFrames = 6;
    const truthStart = targetAt(sourceInFrames + ref);
    const result = await run({ type: "track", config: { ffmpeg, ffprobe }, file, inSeconds: sourceInFrames / 30, duration: 1, fps: 30, referenceFrame: ref, point: { x: truthStart.x / width, y: truthStart.y / height }, radius: 26 });
    assert.equal(result.lost, false);
    assert.equal(result.truncated, false);
    assert.equal(result.samples.length, 30);
    assert.deepEqual(result.range, { startFrame: 0, endFrame: 29 });
    let maxError = 0;
    for (const p of result.samples) {
      const truth = targetAt(sourceInFrames + p.frame);
      maxError = Math.max(maxError, Math.hypot(p.x * width - truth.x, p.y * height - truth.y));
    }
    assert.ok(maxError < 2, "decoded max error " + maxError);
    const offsets = trackingOffsets(result);
    assert.equal(offsets[0].dx, 0);
    assert.equal(offsets[0].frame, 0);
    assert.ok(Math.abs(offsets.at(-1).dx * width - 58) < 2);
    console.log("H.264 trimmed-range max error:", maxError.toFixed(3), "px");
  } finally {
    // Only files generated by this test, under its unique temp directory.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});

test("Incomplete tracking is never converted into host keyframes", () => {
  assert.throws(() => trackingOffsets({ lost: true, samples: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), /incompleto/);
  assert.throws(() => trackingOffsets({ truncated: true, samples: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), /incompleto/);
});

test("PNG destinations can be probed without a video frame rate or duration", { skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ponto-png-test-"));
  const file = path.join(folder, "icon.png");
  try {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x32", "-frames:v", "1", file], { windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const data = await run({ type: "probe", config: { ffmpeg, ffprobe }, file });
    assert.equal(data.width, 64); assert.equal(data.height, 32);
    assert.equal(data.pixelAspectRatio, 1);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});

test("Explicit inclusive In/Out is analyzed on both sides of a middle or last reference", { skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-range-test-"));
  const file = path.join(folder, "fixture.mp4");
  try {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-pix_fmt", "yuv420p", file], { input: Buffer.concat(Array.from({ length: frames }, (_, i) => rgbFrame(i))), maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    for (const referenceFrame of [19, 35]) {
      const seed = targetAt(referenceFrame);
      const result = await run({ type: "track", config: { ffmpeg, ffprobe }, file, inSeconds: 0, duration: frames / 30, fps: 30, startFrame: 5, endFrame: 35, referenceFrame, point: { x: seed.x / width, y: seed.y / height }, radius: 26 });
      assert.equal(result.samples.length, 31); assert.equal(result.lost, false);
      assert.equal(result.samples[0].frame, 5); assert.equal(result.samples.at(-1).frame, 35);
      for (const sample of result.samples) {
        const truth = targetAt(sample.frame);
        assert.ok(Math.hypot(sample.x * width - truth.x, sample.y * height - truth.y) < 2);
      }
    }
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(folder); }
});

test("Target loss retains the valid half for later repair and cannot be applied", { skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-loss-test-")), file = path.join(folder, "fixture.mp4");
  try {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-pix_fmt", "yuv420p", file], { input: Buffer.concat(Array.from({ length: 30 }, (_, i) => rgbFrame(i, i >= 20))), maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const seed = targetAt(10), result = await run({ type: "track", config: { ffmpeg, ffprobe }, file, inSeconds: 0, duration: 1, fps: 30, referenceFrame: 10, point: { x: seed.x / width, y: seed.y / height }, radius: 26, lostTolerance: 2 });
    assert.equal(result.lost, true); assert.equal(result.samples[0].frame, 0);
    assert.ok(result.samples.at(-1).frame <= 19); assert.ok(result.samples.length >= 18);
    assert.ok(result.missing.some(range => range.endFrame === 29));
    assert.throws(() => trackingOffsets(result), /incompleto/);
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(folder); }
});

test("Lost-frame tolerance can reacquire, but the occluded frames stay missing", { skip: !fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe) }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-reacquire-test-")), file = path.join(folder, "fixture.mp4");
  try {
    const encoded = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", "30", "-i", "pipe:0", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-pix_fmt", "yuv420p", file], { input: Buffer.concat(Array.from({ length: 30 }, (_, i) => rgbFrame(i, i === 10 || i === 11))), maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    assert.equal(encoded.status, 0, String(encoded.stderr));
    const seed = targetAt(5), result = await run({ type: "track", config: { ffmpeg, ffprobe }, file, inSeconds: 0, duration: 1, fps: 30, referenceFrame: 5, point: { x: seed.x / width, y: seed.y / height }, radius: 26, lostTolerance: 3 });
    assert.deepEqual(result.missing, [{ startFrame: 10, endFrame: 11 }]);
    assert.equal(result.samples.at(-1).frame, 29); assert.equal(result.lost, true);
    assert.ok(!result.samples.some(sample => sample.frame === 10 || sample.frame === 11));
    assert.throws(() => trackingOffsets(result), /incompleto/);
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(folder); }
});
