"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
function panel(storage = new Map()) {
  const elements = new Map(), calls = [], written = [], jobs = [], players = [], animationFrames = new Map();
  let rafId = 0, trackHandler = null, holdTrack = false, frameFailure = null, imageFailure = false, exitBeforeFrame = false, workerClose = null;
  let probeResult = { width: 64, height: 64, pixelAspectRatio: 1 };
  const drawingCalls = [];
  const drawing = new Proxy({}, { get(target, name) {
    if (name in target) return target[name];
    return (...args) => drawingCalls.push({ operation: name, args, lineWidth: target.lineWidth, strokeStyle: target.strokeStyle, fillStyle: target.fillStyle });
  } });
  function element(id, tagName = "DIV") {
    const listeners = new Map(), attributes = new Map();
    return { id, tagName, style: {}, value: "0", max: "1", disabled: true, hidden: false, checked: false, width: 320, height: 180,
      getContext: () => drawing, getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }),
      setAttribute(k, v) { attributes.set(k, String(v)); }, getAttribute: k => attributes.get(k) || null,
      removeAttribute(k) { attributes.delete(k); if (k === "src") this.src = ""; },
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(callback); },
      dispatch(name, event = {}) { for (const callback of listeners.get(name) || []) callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); },
      listeners, attributes
    };
  }
  const doc = { ...element("document"), body: { appendChild() {} }, createElement(tagName) {
    const node = element("", tagName.toUpperCase());
    if (tagName === "video") {
      Object.assign(node, { src: "", currentTime: 0, readyState: 0, videoWidth: 0, videoHeight: 0, ended: false, playCount: 0, pauseCount: 0, loadCount: 0,
        play() { this.playCount += 1; return Promise.resolve(); }, pause() { this.pauseCount += 1; },
        load() { this.loadCount += 1; this.readyState = this.src ? 2 : 0; this.videoWidth = this.src ? 320 : 0; this.videoHeight = this.src ? 180 : 0; }
      });
      players.push(node);
    }
    return node;
  }, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element(id));
    return elements.get(id);
  } };
  doc.getElementById("radius").value = "26";
  doc.getElementById("confidence").value = "0.30";
  doc.getElementById("lost-tolerance").value = "5";
  const source = { id: "source", name: "Fixture", file: "C:/fixture.mp4", inSeconds: 0, duration: 1, fps: 30, frameTicks: "8467200000", sequence: "seq", startTicks: "0", endTicks: "254016000000" };
  let nextClip = source;
  let applicationFailure = null;
  let currentSource = source;
  let selectedTargets = [{ ...source, id: "text", name: "Title", canvasMedia: true, sequenceWidth: 1920, sequenceHeight: 1080 }];
  const fakeFs = { readFileSync: () => JSON.stringify({ node: "node", ffmpeg: "ffmpeg", ffprobe: "ffprobe" }), existsSync: () => true, mkdtempSync: () => "C:/ponto-test", writeFileSync: (p, data) => written.push(JSON.parse(data)), unlinkSync() {}, rmdirSync() {} };
  function tracked(job, overrides = {}) {
    const start = job.startFrame || 0, end = job.endFrame === undefined ? 29 : job.endFrame;
    const reference = job.referenceFrame || 0, point = job.point || { x: 0.25, y: 0.45 };
    return { schema: 2, fps: job.fps, referenceFrame: reference, totalFrames: Math.ceil(job.duration * job.fps - 0.00001), range: { startFrame: start, endFrame: end },
      samples: Array.from({ length: end - start + 1 }, (_, i) => ({ frame: start + i, x: point.x + (start + i - reference) * 0.001, y: point.y + (start + i - reference) * 0.001 })),
      source: { width: 320, height: 180, file: job.file, inSeconds: job.inSeconds, duration: job.duration, fps: job.fps, pixelAspectRatio: 1 }, lost: false, truncated: false, ...overrides };
  }
  const fakeProcess = { fork() {
    const child = new EventEmitter(); child.connected = true; child.stderr = new EventEmitter();
    child.send = job => {
      jobs.push(job);
      if (job.type === "track" && holdTrack) { child.pending = true; return; }
      setImmediate(() => {
        if (workerClose) {
          child.emit("exit", workerClose.code, workerClose.signal);
          if (workerClose.stderr) child.stderr.emit("data", Buffer.from(workerClose.stderr));
          child.emit("close", workerClose.code, workerClose.signal); return;
        }
        if (job.type === "cancel") { if (child.pending) child.emit("message", { type: "error", message: "Análise cancelada." }); return; }
        try {
          if (job.type === "frame" && frameFailure) throw new Error(frameFailure);
          const result = job.type === "frame" ? { width: 320, height: 180, previewWidth: 320, previewHeight: 180, image: "test" }
            : job.type === "audio" ? { hasAudio: true, waveform: [0.2, 0.6, 0.3, 0.8], cacheDir: "C:/ponto-test", audioFile: "C:/ponto-test/preview.wav", videoFile: "C:/ponto-test/preview.mp4" }
            : job.type === "probe" ? probeResult
            : trackHandler ? trackHandler(job, tracked) : tracked(job);
          if (exitBeforeFrame && job.type === "frame") child.emit("exit", 0, null);
          child.emit("message", { type: "done", result });
          child.emit("close", 0, null);
        } catch (error) { child.emit("message", { type: "error", message: error.message }); }
      });
    };
    return child;
  } };
  const fakeWindow = { ...element("window"), requestAnimationFrame(fn) { const id = ++rafId; animationFrames.set(id, fn); return id; }, cancelAnimationFrame(id) { animationFrames.delete(id); },
    localStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) }, __adobe_cep__: { evalScript(script, callback) {
    calls.push(script);
    if (script.includes("$.evalFile")) { callback("0.5.1"); return; }
    if (script.includes("preparePaste")) { callback(JSON.stringify({ ok: true, source: currentSource, targets: selectedTargets })); return; }
    if (script.includes("prepareStabilize")) { callback(JSON.stringify({ ok: true, source: currentSource, targets: [currentSource] })); return; }
    if (script.includes("applyFromFile")) { callback(JSON.stringify(applicationFailure || { ok: true, targets: written.at(-1).targets.map(t => ({ id: t.target.id, keyframes: t.points.length })) })); return; }
    callback(JSON.stringify({ ok: true, clip: nextClip }));
  } }, cep_node: { require(name) {
    if (name === "fs") return fakeFs;
    if (name === "path") return path;
    if (name === "child_process") return fakeProcess;
    if (name === "os") return require("node:os");
    if (name.endsWith("core.cjs")) return require("../core.cjs");
    throw new Error("Unexpected module: " + name);
  } } };
  function Image() { let src = ""; this.naturalWidth = 320; this.naturalHeight = 180; Object.defineProperty(this, "src", { get: () => src, set(value) { src = value; setImmediate(() => imageFailure ? this.onerror() : this.onload()); } }); }
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../main.js"), "utf8"), vm.createContext({ window: fakeWindow, document: doc, Image, location: { pathname: "/C:/ponto/index.html" }, setTimeout, clearTimeout, Promise, console }));
  return { ui: Object.fromEntries(elements), calls, written, jobs, players, storage, source, document: doc, window: fakeWindow, animationFrames, drawingCalls,
    saved() { return JSON.parse(storage.get("ponto-tracker.clipboard.v1") || "null"); },
    setClip(value) { nextClip = value; }, select(values) { selectedTargets = values; }, failApplication(value) { applicationFailure = value; }, moveSource(value) { currentSource = value; },
    trackResponse(fn) { trackHandler = fn; }, holdTracking(value) { holdTrack = value; },
    failFrame(value) { frameFailure = value; }, failImage(value) { imageFailure = value; }, probeResponse(value) { probeResult = value; },
    exitBeforeFrame(value) { exitBeforeFrame = value; }, closeWorker(value) { workerClose = value; }
  };
}
async function analyzed(p) { await p.ui.load.onclick(); p.ui.preview.onclick({ clientX: 80, clientY: 81 }); await p.ui.track.onclick(); }

test("Tracker marker stays 18 CSS pixels with a 2px white stroke and 5px black outline at every preview scale", async () => {
  const p = panel(); await p.ui.load.onclick();
  for (const [width, height, cssWidth, cssHeight] of [[540,960,480,260],[3840,2160,320,180],[320,180,960,540],[960,540,320,180]]) {
    p.ui.preview.width = width; p.ui.preview.height = height;
    p.ui.preview.getBoundingClientRect = () => ({ left: 0, top: 0, width: cssWidth, height: cssHeight });
    p.drawingCalls.length = 0;
    p.ui.preview.onclick({ clientX: cssWidth / 2, clientY: cssHeight / 2 });
    const fit = Math.min(cssWidth / width, cssHeight / height);
    const white = p.drawingCalls.filter(call => call.operation === "strokeRect" && call.strokeStyle === "#ffffff").at(-1);
    const black = p.drawingCalls.filter(call => call.operation === "strokeRect" && call.strokeStyle === "#050505").at(-1);
    assert.ok(white && black, "both contrast strokes are present");
    assert.ok(Math.abs(white.args[2] * fit - 18) < 1e-9);
    assert.ok(Math.abs(white.lineWidth * fit - 2) < 1e-9);
    assert.ok(Math.abs(black.lineWidth * fit - 5) < 1e-9);
    assert.equal(p.ui.radius.value, "26", "visibility does not change the tracking search radius");
  }
});

test("Resizing redraws the marker at the same visible size without changing the saved tracking", async () => {
  const p = panel(); await analyzed(p); const before = p.saved().result;
  p.ui.preview.getBoundingClientRect = () => ({ left: 0, top: 0, width: 160, height: 90 });
  p.drawingCalls.length = 0; p.window.dispatch("resize");
  const white = p.drawingCalls.find(call => call.operation === "strokeRect" && call.strokeStyle === "#ffffff");
  assert.ok(white); assert.equal(white.args[2] * 0.5, 18); assert.equal(white.lineWidth * 0.5, 2);
  assert.deepEqual(p.saved().result, before);
});

test("Load preserves the real decoder error instead of replacing it with a generic preview failure", async () => {
  const p = panel(); p.failFrame("FFmpeg: codec não disponível nesta mídia.");
  await p.ui.load.onclick();
  assert.equal(p.ui.status.textContent, "FFmpeg: codec não disponível nesta mídia.");
  assert.equal(p.ui.status.className, "error"); assert.equal(p.ui.track.disabled, true);
  assert.deepEqual(p.jobs.map(job => job.type), ["frame"]);
  p.failFrame(null); await p.ui.load.onclick();
  assert.equal(p.ui.empty.style.display, "none"); assert.equal(p.ui["audio-play"].disabled, false);
});

test("CEP exit delivered before the final frame message does not discard the preview", async () => {
  const p = panel(); p.exitBeforeFrame(true); await p.ui.load.onclick();
  assert.equal(p.ui.empty.style.display, "none");
  assert.equal(p.ui["audio-play"].disabled, false);
  assert.deepEqual(p.jobs.map(job => job.type), ["frame", "audio"]);
});

test("A worker crash reports its exit signal and stderr delivered after exit", async () => {
  const p = panel(); p.closeWorker({ code: null, signal: "SIGABRT", stderr: "Runtime indisponível" });
  await p.ui.load.onclick();
  assert.match(p.ui.status.textContent, /SIGABRT.*Runtime indisponível/);
  assert.equal(p.ui.status.className, "error");
  assert.equal(p.ui.track.disabled, true);
});

test("A failed JPEG display cannot be mistaken for a successfully loaded frame", async () => {
  const p = panel(); p.failImage(true); await p.ui.load.onclick();
  assert.match(p.ui.status.textContent, /Falha ao mostrar o preview/);
  assert.equal(p.ui["audio-play"].disabled, true); assert.equal(p.ui.paste.disabled, true);
  assert.deepEqual(p.jobs.map(job => job.type), ["frame"]);
});

test("Quarter-turned target video dimensions and interpreted PAR use the same upright basis", async () => {
  const p = panel(); await analyzed(p);
  p.select([{ ...p.source, id: "portrait", canvasMedia: false, pixelAspectRatio: 4 / 3 }]);
  p.probeResponse({ width: 1080, height: 1920, encodedWidth: 1920, encodedHeight: 1080, rotation: 90, pixelAspectRatio: 3 / 4 });
  await p.ui.paste.onclick();
  assert.equal(p.written[0].targets[0].width, 1080); assert.equal(p.written[0].targets[0].height, 1920);
  assert.equal(p.written[0].targets[0].pixelAspectRatio, 3 / 4);
});

test("Scrubbing locks point placement until the requested frame is ready", async () => {
  const p = panel(); await analyzed(p);
  const before = p.saved().point;
  p.ui.scrub.value = "12";
  const pending = p.ui.scrub.oninput();
  assert.equal(p.ui.track.disabled, true);
  p.ui.preview.onclick({ clientX: 160, clientY: 90 });
  assert.deepEqual(p.saved().point, before);
  await pending;
  assert.equal(p.ui.track.disabled, false);
  assert.equal(p.jobs.at(-1).type, "frame");
  assert.equal(p.jobs.at(-1).referenceFrame, 12);
  assert.equal(p.saved().result.samples.length, 30);
});

test("A delayed playback promise cannot restart audio or the cursor after tracking", async () => {
  const p = panel(); await analyzed(p);
  let resolvePlay;
  p.players[0].play = () => new Promise(resolve => { resolvePlay = resolve; });
  const pending = p.ui["audio-play"].onclick();
  await p.ui.track.onclick();
  resolvePlay(); await pending;
  assert.equal(p.ui["audio-play"].getAttribute("aria-pressed"), "false");
  assert.equal(p.animationFrames.size, 0);
  assert.equal(p.ui.paste.disabled, false);
});
test("Import, point, Play enable two distinct Paste Track / Stabilize actions", async () => {
  const p = panel(), { ui } = p;
  assert.equal(ui.paste.disabled, true); assert.equal(ui.stabilize.disabled, true);
  await ui.load.onclick(); assert.equal(ui.track.disabled, true);
  ui.preview.onclick({ clientX: 80, clientY: 81 }); assert.equal(ui.track.disabled, false);
  await ui.track.onclick(); assert.equal(ui.paste.disabled, false); assert.equal(ui.stabilize.disabled, false);
});
test("Paste consumes current destinations but keeps the source buffer available", async () => {
  const p = panel(); await analyzed(p); await p.ui.paste.onclick();
  assert.equal(p.written[0].mode, "paste"); assert.equal(p.written[0].source.id, "source"); assert.equal(p.written[0].targets[0].target.id, "text");
  assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
  p.select([{ ...p.source, id: "png", canvasMedia: false }]); await p.ui.paste.onclick();
  assert.equal(p.written.length, 2); assert.equal(p.written[1].targets[0].width, 64);
});
test("Stabilize always routes to imported video without asking for current selection", async () => {
  const p = panel(); await analyzed(p); await p.ui.stabilize.onclick();
  assert.equal(p.written[0].mode, "stabilize"); assert.equal(p.written[0].targets[0].target.id, "source");
  assert.equal(p.calls.filter(s => s.includes("preparePaste")).length, 0);
  assert.equal(p.ui.stabilize.disabled, false); assert.equal(p.ui.paste.disabled, false);
});
test("Rejected new imports invalidate the previous clipboard", async () => {
  const p = panel(); await analyzed(p); p.setClip({ ...p.source, duration: 120 }); await p.ui.load.onclick();
  assert.equal(p.ui.paste.disabled, true); assert.equal(p.ui.stabilize.disabled, true); assert.equal(p.ui.track.disabled, true);
});
test("Partial application failure keeps Paste and Stabilize enabled and permits retry", async () => {
  const p = panel(); await analyzed(p);
  p.failApplication({ ok: false, changed: true, error: 'simulated failure' });
  await p.ui.paste.onclick();
  assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
  assert.match(p.ui.status.textContent, /Tracking mantido/);
  assert.doesNotMatch(p.ui.status.textContent, /importe novamente/);
  p.failApplication(null); await p.ui.paste.onclick(); await p.ui.stabilize.onclick();
  assert.equal(p.written.length, 3); assert.equal(p.calls.filter(s => s.includes('.capture(')).length, 1);
});
test("Repeated paste and stabilize, including smoothing updates, reuse the live buffer", async () => {
  const p = panel(); await analyzed(p);
  await p.ui.paste.onclick(); await p.ui.paste.onclick();
  await p.ui.stabilize.onclick(); p.ui.smooth.value = '2'; await p.ui.stabilize.onclick();
  assert.equal(p.written.length, 4);
  assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
});
test("Preparation refreshes source placement without requiring a new import", async () => {
  const p = panel(); await analyzed(p);
  const moved = { ...p.source, startTicks: '2540160000000', endTicks: '2794176000000' };
  p.moveSource(moved); await p.ui.stabilize.onclick();
  assert.equal(p.written[0].source.startTicks, moved.startTicks);
  assert.equal(p.written[0].targets[0].target.startTicks, moved.startTicks);
});
test("Closing and reopening the panel restores the local analysis without another Play", async () => {
  const p = panel(); await analyzed(p);
  const reopened = panel(p.storage);
  assert.equal(reopened.ui.paste.disabled, false); assert.equal(reopened.ui.stabilize.disabled, false);
  assert.match(reopened.ui.status.textContent, /restaurado/);
  await reopened.ui.paste.onclick(); assert.equal(reopened.written.length, 1);
  assert.equal(reopened.calls.filter(s => s.includes('.capture(')).length, 0);
});

async function seek(p, frame) { p.ui.scrub.value = String(frame); await p.ui.scrub.onchange(); }
function range(p, start, end) {
  p.ui["range-in"].value = String(start); p.ui["range-in"].onchange();
  p.ui["range-out"].value = String(end); p.ui["range-out"].onchange();
}

test("Load prepares real audio/waveform independently of tracking and whole clip remains the default", async () => {
  const p = panel(); await p.ui.load.onclick();
  assert.deepEqual(p.jobs.map(job => job.type), ["frame", "audio"]);
  assert.equal(p.ui["audio-play"].disabled, false); assert.equal(p.ui.track.disabled, true);
  assert.equal(p.players[0].src, "file:///C:/ponto-test/preview.mp4");
  p.ui.preview.onclick({ clientX: 80, clientY: 81 }); await p.ui.track.onclick();
  const task = p.jobs.find(job => job.type === "track");
  assert.equal(task.startFrame, 0); assert.equal(task.endFrame, 29);
  assert.equal(task.confidenceThreshold, 0.3); assert.equal(task.lostTolerance, 5);
  assert.equal(p.saved().result.schema, 2); assert.equal(p.saved().result.samples.length, 30);
});

test("Seeking and selecting a new point do not discard an existing analysis", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  await seek(p, 12); p.ui.preview.onclick({ clientX: 160, clientY: 90 });
  assert.deepEqual(p.saved().result, original);
  assert.equal(p.saved().pointFrame, 12); assert.deepEqual(p.saved().point, { x: 0.5, y: 0.5 });
  assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
  await p.ui.paste.onclick(); assert.equal(p.written[0].targets[0].points.length, 30);
});

test("Repairing In/Out merges measured frames and preserves every frame outside the repair", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  range(p, 10, 20); await seek(p, 12); p.ui.preview.onclick({ clientX: 160, clientY: 90 });
  p.trackResponse((job, make) => {
    const fresh = make(job);
    fresh.samples = fresh.samples.map(sample => ({ ...sample, x: sample.x + (sample.frame === 14 ? 0.005 : 0) }));
    return fresh;
  });
  await p.ui.track.onclick();
  const tasks = p.jobs.filter(job => job.type === "track"), repair = tasks.at(-1), result = p.saved().result;
  assert.equal(repair.startFrame, 10); assert.equal(repair.endFrame, 20); assert.equal(repair.referenceFrame, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(repair.point)), { x: 0.5, y: 0.5 });
  assert.deepEqual(result.samples.filter(p => p.frame < 10 || p.frame > 20), original.samples.filter(p => p.frame < 10 || p.frame > 20));
  assert.notEqual(result.samples[14].x, original.samples[14].x);
  assert.equal(result.samples.length, 30); assert.deepEqual(result.range, { startFrame: 0, endFrame: 29 });
  assert.match(p.ui.status.textContent, /fora do In\/Out foi preservado/); assert.equal(p.ui.paste.disabled, false);
});

test("Failed repair retains the prior analysis and application actions", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  range(p, 10, 20); await seek(p, 12);
  p.trackResponse(() => { throw new Error("Tracker simulado falhou"); });
  await p.ui.track.onclick();
  assert.deepEqual(p.saved().result, original); assert.match(p.ui.status.textContent, /Tracker simulado falhou.*anterior preservado/);
  assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
});

test("Cancelled repair retains the prior analysis instead of committing a partial worker result", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  range(p, 10, 20); await seek(p, 12); p.holdTracking(true);
  const running = p.ui.track.onclick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.ui.paste.disabled, true); assert.equal(p.ui.cancel.hidden, false);
  p.ui.cancel.onclick(); await running;
  assert.deepEqual(p.saved().result, original); assert.match(p.ui.status.textContent, /cancelada.*anterior preservado/);
  assert.equal(p.jobs.at(-1).type, "cancel"); assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.cancel.hidden, true);
});

test("An incompatible replacement is not allowed to overwrite an existing analysis", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  range(p, 10, 20); await seek(p, 12);
  p.trackResponse((job, make) => { const fresh = make(job); fresh.source.file = "C:/different.mp4"; return fresh; });
  await p.ui.track.onclick();
  assert.deepEqual(p.saved().result, original); assert.match(p.ui.status.textContent, /origem mudou.*anterior preservado/);
});

test("Motion blur toggle is sent as a boolean for Paste and Stabilize", async () => {
  const p = panel(); await analyzed(p);
  const original = p.saved().result;
  for (const enabled of [false, true]) for (const mode of ["paste", "stabilize"]) {
    p.ui["motion-blur"].checked = enabled; p.ui["motion-blur"].onchange();
    await p.ui[mode].onclick();
    assert.equal(p.written.at(-1).mode, mode);
    assert.equal(p.written.at(-1).motionBlur, enabled);
    assert.equal(p.saved().motionBlur, enabled);
    assert.deepEqual(p.saved().result, original);
    assert.equal(p.ui.status.className, "success");
    assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
  }
});

test("An unsupported motion blur control produces a visible warning without losing tracking", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  p.ui["motion-blur"].checked = true;
  p.failApplication({ ok: true, targets: [{ id: "text", motionBlur: { requested: true, applied: false, warning: "Obturador indisponível nesta versão." } }] });
  await p.ui.paste.onclick();
  assert.equal(p.ui.status.className, "warning"); assert.match(p.ui.status.textContent, /Obturador indisponível/);
  assert.deepEqual(p.saved().result, original); assert.equal(p.ui.paste.disabled, false);
});

test("Resetting the tracker point to center retains the existing result", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  await seek(p, 8); p.ui["reset-point"].onclick();
  assert.deepEqual(p.saved().result, original); assert.deepEqual(p.saved().point, { x: 0.5, y: 0.5 });
  assert.equal(p.saved().pointFrame, 8); assert.match(p.ui.status.textContent, /recentralizado.*mantido/);
  assert.equal(p.ui.paste.disabled, false); assert.equal(p.ui.stabilize.disabled, false);
});

test("Restored analysis prepares the player on demand without re-tracking or capturing again", async () => {
  const original = panel(); await analyzed(original);
  const p = panel(original.storage), result = p.saved().result;
  assert.equal(p.jobs.length, 0); assert.equal(p.ui["audio-play"].disabled, false);
  await p.ui["audio-play"].onclick();
  assert.deepEqual(p.jobs.map(job => job.type), ["audio"]);
  assert.equal(p.players[0].playCount, 1); assert.equal(p.players[0].src, "file:///C:/ponto-test/preview.mp4");
  assert.equal(p.calls.filter(script => script.includes(".capture(")).length, 0);
  assert.deepEqual(p.saved().result, result); assert.equal(p.ui["audio-play"].getAttribute("aria-pressed"), "true");
  await p.ui["audio-play"].onclick(); assert.equal(p.animationFrames.size, 0);
  assert.equal(p.ui["audio-play"].getAttribute("aria-pressed"), "false");
});

test("Loupe and path visibility are independent from the saved tracking", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  p.ui["toggle-loupe"].onclick(); p.ui.preview.dispatch("mousemove", { clientX: 80, clientY: 81 });
  assert.equal(p.ui.loupe.hidden, false); assert.equal(p.ui["toggle-loupe"].getAttribute("aria-pressed"), "true");
  p.ui.preview.dispatch("mouseleave"); assert.equal(p.ui.loupe.hidden, true);
  p.ui["toggle-path"].onclick(); assert.equal(p.ui["toggle-path"].getAttribute("aria-pressed"), "false");
  assert.deepEqual(p.saved().result, original); assert.equal(p.ui.paste.disabled, false);
});

test("In/Out keyboard shortcuts and frame stepping select a repair without clearing tracking", async () => {
  const p = panel(); await analyzed(p); const original = p.saved().result;
  await seek(p, 5); p.document.dispatch("keydown", { key: "i" });
  await seek(p, 18); p.document.dispatch("keydown", { key: "o" });
  assert.equal(Number(p.ui["range-in"].value), 5); assert.equal(Number(p.ui["range-out"].value), 18);
  p.ui["range-in-handle"].dispatch("keydown", { key: "ArrowRight" });
  assert.equal(Number(p.ui["range-in"].value), 6);
  await p.ui["step-back"].onclick(); assert.equal(Number(p.ui.scrub.value), 17);
  await p.ui["step-forward"].onclick(); assert.equal(Number(p.ui.scrub.value), 18);
  assert.deepEqual(p.saved().result, original);
});

test("Clear tracking removes only the local clipboard, never a Premiere effect", async () => {
  const p = panel(); await analyzed(p); const calls = p.calls.length;
  p.ui["clear-track"].onclick();
  assert.equal(p.saved(), null); assert.equal(p.calls.length, calls);
  assert.equal(p.ui.paste.disabled, true); assert.equal(p.ui.stabilize.disabled, true);
  assert.equal(p.ui.track.disabled, false); assert.match(p.ui.status.textContent, /Nenhum efeito foi removido/);
});
