"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { aspectRatio, transferFrames } = require("../core.cjs");
const T = 254016000000, frameTicks = String(T / 30);
const source = { sequence: "s", frameTicks, fps: 30, startTicks: String(5 * T), endTicks: String(7 * T), duration: 2 };
const track = { samples: Array.from({ length: 60 }, (_, i) => ({ frame: i, x: i / 1000, y: i / 2000 })), lost: false, truncated: false };
test("PAR parser supports rationals without treating square pixels as NaN", () => {
  for (const value of [1, "1.0", "1:1", "1/1", "1,0"]) assert.equal(aspectRatio(value), 1);
  assert.equal(aspectRatio("4:3"), 4 / 3); assert.throws(() => aspectRatio("1:0"));
});
test("Overlapping overlays follow matching sequence frames and start with zero displacement", () => {
  const target = { ...source, startTicks: String(6 * T), endTicks: String(7 * T), duration: 1 };
  const frames = transferFrames(track, source, target);
  assert.equal(frames.length, 30); assert.equal(frames[0].frame, 0); assert.equal(frames[0].dx, 0);
  assert.ok(Math.abs(frames.at(-1).dx - 0.029) < 1e-10);
});
test("A destination elsewhere receives motion from its first frame, clipped to its duration", () => {
  const target = { ...source, startTicks: String(20 * T), endTicks: String(21 * T), duration: 1 };
  const frames = transferFrames(track, source, target);
  assert.equal(frames.length, 30); assert.equal(frames[0].frame, 0); assert.equal(frames.at(-1).frame, 29);
});
test("Reference offsets and cross-sequence destinations are handled explicitly", () => {
  const delayed = { ...track, samples: track.samples.slice(10) };
  const target = { ...source, startTicks: String(20 * T), endTicks: String(22 * T) };
  const frames = transferFrames(delayed, source, target);
  assert.equal(frames[0].frame, 0); assert.equal(frames[0].dx, 0);
  assert.throws(() => transferFrames(track, source, { ...target, sequence: "other" }), /mesma sequência/);
});
