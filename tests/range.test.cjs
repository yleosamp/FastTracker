"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mergeTracking, selectTrackingRange, trackingOffsets, trackingBounds } = require("../core.cjs");
function result(start = 0, end = 29, shiftX = 0, shiftY = 0) {
  return {
    schema: 2, fps: 30, totalFrames: 30, range: { startFrame: start, endFrame: end }, referenceFrame: start,
    source: { file: "C:/fixture.mp4", revision: "1000:123", width: 320, height: 180, pixelAspectRatio: 1, inSeconds: 2, duration: 1, fps: 30 },
    width: 320, height: 180,
    samples: Array.from({ length: end - start + 1 }, (_, i) => ({ frame: start + i, x: 0.2 + (start + i) / 1000 + shiftX, y: 0.3 + (start + i) / 2000 + shiftY, confidence: 0.9 })),
    lost: false, truncated: false
  };
}
test("Repair preserves all samples outside inclusive In/Out and rebases a different seed", () => {
  const previous = result(), before = JSON.stringify(previous);
  const repair = result(8, 17, 0.25, -0.1); repair.referenceFrame = 12;
  const merged = mergeTracking(previous, repair);
  assert.equal(JSON.stringify(previous), before);
  assert.equal(merged.samples.length, 30); assert.equal(merged.lost, false);
  assert.equal(merged.alignment.frame, 12);
  for (let i = 0; i < 30; i += 1) {
    assert.ok(Math.abs(merged.samples[i].x - previous.samples[i].x) < 1e-12);
    assert.ok(Math.abs(merged.samples[i].y - previous.samples[i].y) < 1e-12);
    if (i < 8 || i > 17) assert.deepEqual(merged.samples[i], previous.samples[i]);
  }
});
test("Partial runs retain genuine samples and cannot generate host keys until gaps are repaired", () => {
  const partial = result(); partial.samples = partial.samples.filter(sample => sample.frame < 10 || sample.frame > 14); partial.lost = true; partial.truncated = true;
  const retained = mergeTracking(null, partial);
  assert.deepEqual(retained.missing, [{ startFrame: 10, endFrame: 14 }]);
  assert.throws(() => trackingOffsets(retained), /incompleto/);
  const repaired = mergeTracking(retained, result(9, 15, 0.12));
  assert.deepEqual(repaired.missing, []); assert.equal(repaired.lost, false); assert.equal(trackingOffsets(repaired).length, 30);
});
test("A deliberate complete I/O segment can be applied, but an unknown frame is never invented", () => {
  const partial = result(); partial.samples = partial.samples.filter(sample => sample.frame !== 10); partial.lost = true;
  assert.equal(trackingOffsets(selectTrackingRange(partial, 0, 9)).length, 10);
  assert.throws(() => selectTrackingRange(partial, 0, 11), /incompleto/);
  assert.throws(() => selectTrackingRange(partial, 5, 5), /incompleto/);
  assert.throws(() => selectTrackingRange(partial, -1, 9), /In\/Out/);
});
test("Merging without any common valid frame is rejected with instructions", () => {
  assert.throws(() => mergeTracking(result(0, 8), result(9, 29)), /pelo menos um frame/);
});
test("Source file, media revision, trim, fps and frame grid must match", () => {
  for (const change of [{ file: "C:/other.mp4" }, { revision: "1000:124" }, { inSeconds: 2.1 }, { duration: 1.1 }, { width: 640 }, { fps: 29.97 }, { pixelAspectRatio: "4:3" }]) {
    const replacement = result(4, 14); replacement.source = { ...replacement.source, ...change };
    assert.throws(() => mergeTracking(result(), replacement), /origem|fps|Duração/);
  }
  const replacement = result(4, 14); replacement.source.file = "c:\\FIXTURE.mp4";
  assert.equal(mergeTracking(result(), replacement).samples.length, 30);
});
test("Mismatched movement at a repair seam is rejected instead of creating a jump", () => {
  const replacement = result(4, 24); replacement.samples.at(-1).x += 0.2;
  assert.throws(() => mergeTracking(result(), replacement), /sem salto/);
});
test("Newly lost frames inside a repair remain gaps and outside samples are retained", () => {
  const replacement = result(8, 15); replacement.samples = replacement.samples.filter(sample => sample.frame !== 13); replacement.lost = true;
  const merged = mergeTracking(result(), replacement);
  assert.deepEqual(merged.missing, [{ startFrame: 13, endFrame: 13 }]);
  assert.equal(merged.samples.length, 29); assert.equal(merged.lost, true);
});
test("Malformed samples, duplicate frames and discontinuous legacy data cannot be applied", () => {
  for (const mutate of [data => data.samples.reverse(), data => data.samples[1].frame = 0, data => data.samples[1].x = NaN, data => data.range.endFrame = 30, data => data.totalFrames = 29]) {
    const data = result(); mutate(data); assert.throws(() => trackingBounds(data), /inválid|fora/);
  }
  const legacy = { samples: [{ frame: 0, x: 0, y: 0 }, { frame: 2, x: 1, y: 1 }], lost: false, truncated: false };
  assert.throws(() => trackingOffsets(legacy), /incompleto/);
  assert.throws(() => trackingOffsets(result(), NaN), /Suavização/);
  const missingFps = result(); delete missingFps.fps;
  assert.throws(() => mergeTracking(null, missingFps), /fps/);
});
