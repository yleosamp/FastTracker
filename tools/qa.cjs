"use strict";

// Isolated browser integration checks. No Adobe process, project, original
// media, installed extension, network service, or production filesystem is used.
// main.js and core.cjs are real; the CEP host/worker IPC and writes are mocked.
// The MP4 has generated test bars + a sine tone, never a user's footage.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const runtime = JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8"));
const playwrightPath = process.env.FASTTRACKER_PLAYWRIGHT || "playwright";
const edgePath = process.env.FASTTRACKER_BROWSER;
const { chromium } = require(playwrightPath);
const jpeg = require(path.join(root, "node_modules", "jpeg-js"));
const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-browser-qa-"));
const videoFile = path.join(artifacts, "generated-fixture.mp4");
const ffmpeg = process.env.FASTTRACKER_FFMPEG || runtime.ffmpeg;
const generated = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=22050", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-n", videoFile], { windowsHide: true, encoding: "utf8" });
if (generated.status !== 0) throw new Error("Synthetic fixture generation failed: " + (generated.stderr || generated.error));
const pixels = Buffer.alloc(640 * 360 * 4);
for (let y = 0; y < 360; y += 1) for (let x = 0; x < 640; x += 1) {
  const p = (y * 640 + x) * 4, grid = x % 40 < 2 || y % 40 < 2;
  const square = x > 225 && x < 295 && y > 145 && y < 215;
  pixels[p] = square ? 225 : grid ? 75 : 28 + Math.floor(x / 9);
  pixels[p + 1] = square ? 172 : grid ? 85 : 34 + Math.floor(y / 9);
  pixels[p + 2] = square ? 80 : grid ? 100 : 52;
  pixels[p + 3] = 255;
}
const image = jpeg.encode({ data: pixels, width: 640, height: 360 }, 75).data.toString("base64");
const coreSource = fs.readFileSync(path.join(root, "core.cjs"), "utf8");
const fixture = {
  image, videoFile,
  clip: { name: "SYNTHETIC QA ONLY.mp4", file: videoFile, id: "qa-source", nodeId: "qa-source", sequence: "qa-sequence", sequenceWidth: 1920, sequenceHeight: 1080, sequencePixelAspectRatio: 1, width: 640, height: 360, pixelAspectRatio: 1, fps: 30, duration: 2, inSeconds: 0, startTicks: "0", endTicks: "508032000000", frameTicks: "8467200000", motion: { rotation: 5, scale: 115, position: [0.51, 0.52] } }
};
const portraitVideoFile = path.join(artifacts, "generated-portrait-fixture.mp4");
const generatedPortrait = spawnSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=360x640:rate=30", "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=22050", "-t", "2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-n", portraitVideoFile], { windowsHide: true, encoding: "utf8" });
if (generatedPortrait.status !== 0) throw new Error("Synthetic portrait generation failed: " + (generatedPortrait.stderr || generatedPortrait.error));
function portraitFixture(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const index = (y * width + x) * 4, grid = x % 40 < 2 || y % 40 < 2;
    const target = Math.abs(x - width / 2) < 30 && Math.abs(y - height / 2) < 30;
    data[index] = target ? 220 : grid ? 65 : 26 + Math.floor(x / 10);
    data[index + 1] = target ? 170 : grid ? 85 : 34 + Math.floor(y / 10);
    data[index + 2] = target ? 75 : grid ? 100 : 52;
    data[index + 3] = 255;
  }
  return {
    image: jpeg.encode({ data, width, height }, 75).data.toString("base64"),
    videoFile: portraitVideoFile, previewWidth: width, previewHeight: height,
    clip: { ...fixture.clip, name: "SYNTHETIC PORTRAIT QA ONLY.mp4", file: portraitVideoFile, width: 2160, height: 3840 }
  };
}

function installMocks({ coreSource, fixture }) {
  const coreModule = { exports: {} };
  // The only evaluated text is this repository's core.cjs, not external data.
  new Function("module", "exports", coreSource)(coreModule, coreModule.exports);
  const clone = value => JSON.parse(JSON.stringify(value));
  const mediaWidth = fixture.clip.width || 640, mediaHeight = fixture.clip.height || 360;
  const previewWidth = fixture.previewWidth || 640, previewHeight = fixture.previewHeight || 360;
  const qa = window.__qa = { jobs: [], calls: [], payloads: [], writes: {}, trackCount: 0, captureCount: 0, failNextTrack: false, cancelNextTrack: false };
  const normalize = value => String(value).replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const fakePath = {
    sep: "/", join: (...parts) => normalize(parts.join("/")), resolve: normalize,
    dirname: value => normalize(value).replace(/\/[^/]*$/, ""),
    basename: value => normalize(value).split("/").pop()
  };
  const fakeFs = {
    existsSync: () => true,
    readFileSync: file => /runtime\.json$/.test(file) ? JSON.stringify({ node: "qa-node", ffmpeg: "qa-ffmpeg", ffprobe: "qa-ffprobe" }) : qa.writes[file] || "",
    mkdtempSync: prefix => prefix + "memory-only",
    writeFileSync: (file, text) => { qa.writes[file] = text; if (/apply\.json$/.test(file)) qa.payloads.push(JSON.parse(text)); },
    unlinkSync: file => { delete qa.writes[file]; }, rmdirSync: () => {}
  };
  function fakeFork() {
    const listeners = {};
    const child = {
      connected: true, stderr: { on() {} },
      on(name, fn) { (listeners[name] || (listeners[name] = [])).push(fn); return child; },
      emit(name, value) { (listeners[name] || []).forEach(fn => fn(value)); },
      send(task) {
        if (task.type === "cancel") { child.emit("message", { type: "error", message: "Análise cancelada pelo teste isolado." }); return; }
        qa.jobs.push(clone(task));
        const done = result => child.emit("message", { type: "done", result });
        setTimeout(() => {
          if (task.type === "frame") return done({ width: mediaWidth, height: mediaHeight, pixelAspectRatio: 1, previewWidth, previewHeight, image: fixture.image });
          if (task.type === "audio") return done({ hasAudio: true, waveform: Array.from({ length: 256 }, (_, i) => .22 + Math.abs(Math.sin(i * .17)) * .66), duration: 2, sampleRate: 22050, videoFile: fixture.videoFile });
          if (task.type === "probe") return done({ width: 640, height: 360, pixelAspectRatio: 1 });
          if (task.type !== "track") return child.emit("message", { type: "error", message: "Unknown mocked task." });
          qa.trackCount += 1;
          if (qa.failNextTrack) { qa.failNextTrack = false; return child.emit("message", { type: "error", message: "Falha sintética de teste." }); }
          if (qa.cancelNextTrack) { qa.cancelNextTrack = false; return; }
          const samples = [];
          const wave = frame => qa.trackCount > 1 ? Math.sin((frame - task.startFrame) / Math.max(1, task.endFrame - task.startFrame) * Math.PI) * .003 : 0;
          for (let frame = task.startFrame; frame <= task.endFrame; frame += 1) samples.push({ frame, x: task.point.x + (frame - task.referenceFrame) * .001, y: task.point.y + (frame - task.referenceFrame) * .0003 + wave(frame) - wave(task.referenceFrame), confidence: .98 });
          const reference = samples.find(sample => sample.frame === task.referenceFrame);
          child.emit("message", { type: "progress", frame: task.referenceFrame, point: reference, progress: .5, confidence: .98, image: fixture.image });
          done({ schema: 2, fps: 30, totalFrames: 60, range: { startFrame: task.startFrame, endFrame: task.endFrame }, referenceFrame: task.referenceFrame, source: { file: fixture.videoFile, width: mediaWidth, height: mediaHeight, pixelAspectRatio: 1, inSeconds: 0, duration: 2, fps: 30, revision: "qa-v1" }, samples, missing: [], failures: [], lost: false, truncated: false, width: previewWidth, height: previewHeight });
        }, 15);
      }
    };
    return child;
  }
  window.cep_node = { require(name) {
    if (name === "fs") return fakeFs;
    if (name === "path") return fakePath;
    if (name === "os") return { tmpdir: () => "C:/qa-memory-only", homedir: () => "C:/qa-memory-only" };
    if (name === "child_process") return { fork: fakeFork };
    if (/core\.cjs$/.test(name)) return coreModule.exports;
    throw new Error("Unexpected module in QA browser: " + name);
  } };
  window.__adobe_cep__ = { evalScript(text, callback) {
    if (/PontoTracker\.version$/.test(text)) { setTimeout(() => callback("0.4.4"), 0); return; }
    const match = /^PontoTracker\.([A-Za-z]+)\((.*)\)$/.exec(text);
    if (!match) throw new Error("Unexpected mocked host call.");
    const method = match[1], args = match[2] ? JSON.parse(match[2]) : null;
    qa.calls.push({ method, args });
    let response;
    if (method === "capture") { qa.captureCount += 1; response = { ok: true, clip: fixture.clip }; }
    if (method === "preparePaste") response = { ok: true, source: fixture.clip, targets: [{ ...fixture.clip, id: "qa-title", nodeId: "qa-title", name: "SYNTHETIC TITLE", canvasMedia: true, canvasWidth: 1920, canvasHeight: 1080 }] };
    if (method === "prepareStabilize") response = { ok: true, source: fixture.clip };
    if (method === "applyFromFile") response = { ok: true, targets: [{ id: "qa-applied", motionBlur: { applied: true } }] };
    if (!response) throw new Error("Unexpected host method: " + method);
    setTimeout(() => callback(JSON.stringify(response)), 0);
  } };
  window.cep = { fs: { showSaveDialogEx: () => ({ err: 0, data: "C:/qa-memory-only/export.json" }) } };
}

async function main() {
  const browser = await chromium.launch({ executablePath: edgePath, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"], args: ["--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"] });
  const results = [], pageErrors = [];
  const page = await browser.newPage({ viewport: { width: 1040, height: 1200 }, reducedMotion: "reduce" });
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(installMocks, { coreSource, fixture });
  async function check(name, fn) {
    try { await fn(); results.push({ name, ok: true }); console.log("PASS " + name); }
    catch (error) { results.push({ name, ok: false, error: error.message }); console.error("FAIL " + name + ": " + error.message); }
  }
  const val = id => page.locator("#" + id).inputValue();
  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("ponto-tracker.clipboard.v1")));
  const clickAsync = id => page.evaluate(async id => { const button = document.getElementById(id); if (button.disabled) throw new Error(id + " is disabled"); await button.onclick(); }, id);
  const seek = frame => page.evaluate(async frame => { const input = document.getElementById("scrub"); input.value = frame; await input.onchange(); }, frame);
  const range = (start, end) => page.evaluate(([start, end]) => { const a = document.getElementById("range-in"), b = document.getElementById("range-out"); a.value = start; a.onchange(); b.value = end; b.onchange(); }, [start, end]);
  const pointAt = async (x, y) => {
    const bounds = await page.locator("#preview").boundingBox();
    const fit = Math.min(bounds.width / 640, bounds.height / 360), w = 640 * fit, h = 360 * fit;
    await page.mouse.click(bounds.x + (bounds.width - w) / 2 + w * x, bounds.y + (bounds.height - h) / 2 + h * y);
  };
  try {
    await page.goto(pathToFileURL(path.join(root, "index.html")).href);
    await page.waitForFunction(() => !document.getElementById("load").disabled);
    await check("startup / real main + core, mocked CEP", async () => {
      assert.equal(await page.title(), "FastTracker");
      assert.equal(await page.locator("#track").isDisabled(), true);
      assert.equal(await page.locator("#paste").isDisabled(), true);
      assert.equal(await page.locator("details").getAttribute("open"), null);
      assert.deepEqual(pageErrors, []);
    });
    await check("load generated video / real decodable audio + waveform", async () => {
      await clickAsync("load");
      await page.waitForFunction(() => document.querySelector("video") && document.querySelector("video").readyState >= 2);
      assert.equal(await page.locator("#clip-name").textContent(), fixture.clip.name);
      assert.equal(await val("scrub"), "0");
      assert.equal(await page.locator("#audio-play").isDisabled(), false);
      assert.equal(await page.locator("#mark-in").isDisabled(), false);
      assert.equal(await page.evaluate(() => { const c = document.getElementById("waveform"), a = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < a.length; i += 4) if (a[i + 1] > a[i] + 20 && a[i + 1] > a[i + 2] + 10) n++; return n > 500; }), true);
      assert.deepEqual(await page.evaluate(() => __qa.jobs.map(job => job.type)), ["frame", "audio"]);
    });
    await check("settings update outputs and reach worker IPC", async () => {
      await page.locator("summary").click();
      await page.evaluate(() => { for (const [id, value] of [["radius", "40"], ["confidence", "0.70"], ["lost-tolerance", "3"], ["smooth", "2"]]) { const e = document.getElementById(id); e.value = value; e.oninput(); } });
      assert.equal(await page.locator("#radius-value").textContent(), "40");
      assert.equal(await page.locator("#confidence-value").textContent(), "0.7");
      assert.equal(await page.locator("#lost-tolerance-value").textContent(), "3");
      assert.equal(await page.locator("#smooth-value").textContent(), "2");
      await page.locator("summary").click();
    });
    await check("whole clip tracks both sides of middle reference", async () => {
      await seek(30); await pointAt(.4, .5); await clickAsync("track");
      const data = await stored(), task = await page.evaluate(() => __qa.jobs.filter(job => job.type === "track").at(-1));
      assert.equal(data.result.samples.length, 60);
      assert.deepEqual(data.result.range, { startFrame: 0, endFrame: 59 });
      assert.equal(task.referenceFrame, 30); assert.equal(task.startFrame, 0); assert.equal(task.endFrame, 59);
      assert.equal(task.radius, 40); assert.equal(task.confidenceThreshold, .7); assert.equal(task.lostTolerance, 3);
      assert.equal(await page.locator("#paste").isDisabled(), false);
      assert.equal(await page.locator("#stabilize").isDisabled(), false);
    });
    let original;
    await check("seeking retains tracking / local clipboard", async () => {
      original = (await stored()).result;
      await seek(15);
      assert.deepEqual((await stored()).result, original);
      assert.equal(await page.locator("#paste").isDisabled(), false);
    });
    await check("lupa is circular, follows mouse, fits preview edges", async () => {
      await clickAsync("toggle-loupe");
      const box = await page.locator("#preview").boundingBox();
      await page.mouse.move(box.x + box.width - 3, box.y + box.height - 3);
      assert.equal(await page.locator("#loupe").isVisible(), true);
      const [l, v] = await Promise.all([page.locator("#loupe").boundingBox(), page.locator("#viewer").boundingBox()]);
      assert.ok(l.x >= v.x && l.y >= v.y && l.x + l.width <= v.x + v.width + 1 && l.y + l.height <= v.y + v.height + 1, JSON.stringify({ loupe: l, viewer: v }));
      assert.equal(await page.locator("#loupe").evaluate(e => getComputedStyle(e).borderRadius), "50%");
      await page.mouse.move(2, 2); assert.equal(await page.locator("#loupe").isVisible(), false);
    });
    await check("path toggle and center reset retain saved track", async () => {
      await clickAsync("toggle-path"); assert.equal(await page.locator("#toggle-path").getAttribute("aria-pressed"), "false");
      await clickAsync("toggle-path"); await clickAsync("reset-point");
      assert.deepEqual((await stored()).point, { x: .5, y: .5 });
      assert.deepEqual((await stored()).result, original);
    });
    await check("repair selected In/Out preserves every outside sample", async () => {
      await range(20, 35); await seek(25); await pointAt(.55, .6); await clickAsync("track");
      const data = await stored();
      assert.equal(data.result.samples.length, 60);
      assert.deepEqual(data.result.samples.filter(p => p.frame < 20 || p.frame > 35), original.samples.filter(p => p.frame < 20 || p.frame > 35));
      assert.ok(data.result.samples.some((p, i) => p.frame >= 20 && p.frame <= 35 && Math.abs(p.y - original.samples[i].y) > 1e-8));
      assert.match(await page.locator("#status").textContent(), /fora do In\/Out foi preservado/);
    });
    await check("Paste sends blur off/on and real core offsets without losing tracking", async () => {
      const original = (await stored()).result;
      for (const enabled of [false, true]) {
        if (await page.locator("#motion-blur").isChecked() !== enabled) await page.locator(".icon-toggle").click();
        await clickAsync("paste");
        const payload = await page.evaluate(() => __qa.payloads.at(-1));
        assert.equal(payload.mode, "paste"); assert.equal(payload.motionBlur, enabled);
        assert.equal(payload.targets.length, 1); assert.equal(payload.targets[0].points.length, 60);
        assert.equal(payload.targets[0].points[0].dx, 0); assert.equal(payload.targets[0].points[0].dy, 0);
        assert.equal(payload.source.motion.rotation, 5);
        assert.deepEqual((await stored()).result, original);
      }
    });
    await check("Stabilize targets loaded source / no recapture required", async () => {
      const original = (await stored()).result;
      for (const enabled of [true, false]) {
        if (await page.locator("#motion-blur").isChecked() !== enabled) await page.locator(".icon-toggle").click();
        await clickAsync("stabilize");
        const data = await page.evaluate(() => ({ payload: __qa.payloads.at(-1), captures: __qa.captureCount }));
        assert.equal(data.payload.mode, "stabilize"); assert.equal(data.payload.motionBlur, enabled);
        assert.equal(data.payload.targets[0].target.id, "qa-source"); assert.equal(data.captures, 1);
        assert.deepEqual((await stored()).result, original);
      }
    });
    await check("failed repair retains previous result", async () => {
      const previous = (await stored()).result;
      await page.evaluate(() => __qa.failNextTrack = true); await clickAsync("track");
      assert.deepEqual((await stored()).result, previous);
      assert.match(await page.locator("#status").textContent(), /anterior preservado/);
      assert.equal(await page.locator("#paste").isDisabled(), false);
    });
    await check("cancel preserves previous result", async () => {
      const previous = (await stored()).result;
      await page.evaluate(() => { __qa.cancelNextTrack = true; document.getElementById("track").onclick(); });
      await page.waitForFunction(() => !document.getElementById("cancel").hidden);
      await clickAsync("cancel"); await page.waitForFunction(() => !document.getElementById("track").disabled);
      assert.deepEqual((await stored()).result, previous);
      assert.match(await page.locator("#status").textContent(), /cancelada/);
    });
    await check("keyboard I/O / step / input focus does not hijack", async () => {
      await clickAsync("clear-range"); await seek(10);
      await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press("i");
      assert.equal(await val("range-in"), "10");
      await seek(30); await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press("o");
      assert.equal(await val("range-out"), "30");
      await page.keyboard.press("ArrowLeft"); await page.waitForFunction(() => !document.getElementById("step-forward").disabled);
      assert.equal(await val("scrub"), "29");
      await page.locator("#range-in").focus(); await page.keyboard.press("i"); assert.equal(await val("scrub"), "29");
    });
    await check("range handles support keyboard and actual pointer drag", async () => {
      const handle = page.locator("#range-in-handle");
      assert.equal(await handle.getAttribute("role"), "slider");
      await handle.focus(); await page.keyboard.press("ArrowRight"); assert.equal(await val("range-in"), "11");
      const bounds = await handle.boundingBox(), wave = await page.locator("#waveform-wrap").boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2); await page.mouse.down();
      await page.mouse.move(wave.x + wave.width * 14 / 59, wave.y + wave.height / 2); await page.mouse.up();
      assert.ok(Math.abs(Number(await val("range-in")) - 14) <= 1);
    });
    await check("real preview playback advances cursor / Space pauses", async () => {
      await clickAsync("clear-range"); await seek(0); await clickAsync("audio-play");
      await page.waitForFunction(() => Number(document.getElementById("scrub").value) >= 2);
      assert.equal(await page.locator("#audio-play").getAttribute("aria-pressed"), "true");
      await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press("Space");
      assert.equal(await page.locator("#audio-play").getAttribute("aria-pressed"), "false");
    });
    await check("export JSON is memory-only and contains result", async () => {
      await clickAsync("export");
      const exported = await page.evaluate(() => JSON.parse(__qa.writes["C:/qa-memory-only/export.json"]));
      assert.equal(exported.tracking.samples.length, 60);
    });
    await check("Premiere-style scrollbar / narrow dock scrolls without browser arrows", async () => {
      const previousViewport = page.viewportSize();
      const previousOpen = await page.locator("details").evaluate(e => e.open);
      const previousResult = await stored();
      try {
        await page.setViewportSize({ width: 360, height: 420 });
        await page.locator("details").evaluate(e => e.open = true);
        await page.evaluate(() => scrollTo(0, 0));
        const style = await page.evaluate(() => {
          const root = document.documentElement;
          const bar = getComputedStyle(root, "::-webkit-scrollbar");
          const thumb = getComputedStyle(root, "::-webkit-scrollbar-thumb");
          const button = getComputedStyle(root, "::-webkit-scrollbar-button");
          return { width: bar.width, color: thumb.backgroundColor, border: thumb.borderLeftWidth, button: button.display, height: root.scrollHeight, horizontal: root.scrollWidth > innerWidth };
        });
        assert.equal(style.width, "10px");
        assert.equal(style.color, "rgb(85, 85, 85)");
        assert.equal(style.border, "2px");
        assert.equal(style.button, "none");
        assert.ok(style.height > 420, "small dock needs vertical scrolling");
        assert.equal(style.horizontal, false);
        await page.screenshot({ path: path.join(artifacts, "panel-360x420-scrollbar.png") });
        await page.mouse.move(180, 300);
        await page.mouse.wheel(0, 600);
        await page.waitForFunction(() => scrollY > 100);
        assert.deepEqual(await stored(), previousResult, "scrolling cannot change tracking data");
      } finally {
        await page.locator("details").evaluate((e, open) => e.open = open, previousOpen);
        await page.setViewportSize(previousViewport);
        await page.evaluate(() => scrollTo(0, 0));
      }
    });
    await check("responsive panel / screenshots narrow, reference, horizontal", async () => {
      for (const [width, height] of [[320, 760], [480, 950], [1040, 1200], [960, 540], [750, 480]]) {
        await page.setViewportSize({ width, height });
        for (const open of [false, true]) {
          await page.locator("details").evaluate((e, open) => e.open = open, open);
          const dimensions = await page.evaluate(() => ({ width: innerWidth, available: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, controls: [...document.querySelectorAll("button")].filter(e => !e.hidden && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(e => e.id) }));
          assert.equal(dimensions.width, width); assert.equal(dimensions.scroll, dimensions.available, JSON.stringify(dimensions)); assert.deepEqual(dimensions.controls, []);
          await page.screenshot({ path: path.join(artifacts, `panel-${width}x${height}-${open ? "advanced" : "compact"}.png`), fullPage: true });
        }
      }
    });
    await check("reload restores samples / playback prepares on demand", async () => {
      const previous = (await stored()).result;
      await page.reload(); await page.waitForFunction(() => !document.getElementById("load").disabled);
      assert.deepEqual((await stored()).result, previous);
      assert.equal(await page.locator("#paste").isDisabled(), false);
      await clickAsync("audio-play");
      await page.waitForFunction(() => document.querySelector("video").readyState >= 2);
      await page.waitForFunction(() => document.getElementById("audio-play").getAttribute("aria-pressed") === "true");
      await clickAsync("audio-play");
      assert.deepEqual(await page.evaluate(() => __qa.jobs.map(job => job.type)), ["audio"]);
    });
    await check("clear affects only local buffer / no timeline removal calls", async () => {
      await clickAsync("clear-track"); assert.equal(await stored(), null);
      assert.equal(await page.locator("#paste").isDisabled(), true);
      assert.equal(await page.locator("#stabilize").isDisabled(), true);
      assert.deepEqual(await page.evaluate(() => __qa.calls.filter(call => /delete|remove|reset/i.test(call.method))), []);
    });
    for (const [previewWidth, previewHeight, viewportWidth] of [[360, 640, 360], [540, 960, 480]]) {
      await check(`portrait ${previewWidth}x${previewHeight} / real image coordinates, letterbox exclusion and bounded loupe`, async () => {
        const portrait = await browser.newPage({ viewport: { width: viewportWidth, height: 950 }, reducedMotion: "reduce" });
        portrait.on("pageerror", error => pageErrors.push(error.message));
        try {
          await portrait.addInitScript(installMocks, { coreSource, fixture: portraitFixture(previewWidth, previewHeight) });
          await portrait.goto(pathToFileURL(path.join(root, "index.html")).href);
          await portrait.waitForFunction(() => !document.getElementById("load").disabled);
          await portrait.evaluate(async () => document.getElementById("load").onclick());
          await portrait.waitForFunction(() => document.querySelector("video").readyState >= 2);
          assert.deepEqual(await portrait.locator("#preview").evaluate(e => [e.width, e.height]), [previewWidth, previewHeight]);
          assert.equal(await portrait.locator("#empty").isVisible(), false);
          const box = await portrait.locator("#preview").boundingBox();
          const fit = Math.min(box.width / previewWidth, box.height / previewHeight);
          const width = previewWidth * fit, height = previewHeight * fit;
          const imageBox = { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
          assert.ok(imageBox.x - box.x > 10, "upright image is pillarboxed, not stretched");
          await portrait.mouse.click(box.x + 4, box.y + box.height / 2);
          assert.equal(await portrait.locator("#track").isDisabled(), true, "letterbox cannot seed a tracking point");
          await portrait.locator("#preview").evaluate(e => e.addEventListener("click", event => {
            const rect = e.getBoundingClientRect();
            window.__qa.centerClick = { x: event.clientX, y: event.clientY, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
          }, { once: true }));
          await portrait.mouse.click(imageBox.x + width / 2, imageBox.y + height / 2);
          assert.equal(await portrait.locator("#track").isDisabled(), false);
          const marker = await portrait.evaluate(() => {
            const canvas = document.getElementById("preview"), ctx = canvas.getContext("2d"), rect = canvas.getBoundingClientRect();
            const strokes = [], original = ctx.strokeRect;
            ctx.strokeRect = function (...args) { strokes.push({ args, color: this.strokeStyle, width: this.lineWidth }); return original.apply(this, args); };
            try { document.getElementById("reset-point").onclick(); } finally { ctx.strokeRect = original; }
            const white = strokes.filter(s => s.color === "#ffffff").at(-1), black = strokes.filter(s => s.color === "#050505").at(-1);
            const fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
            return { white, black, fit };
          });
          assert.ok(marker.white && marker.black, "high-contrast outline and white core are drawn");
          assert.ok(Math.abs(marker.white.args[2] * marker.fit - 18) < 1e-8, "marker is 18 CSS pixels, not 18 source pixels");
          // Chromium stores lineWidth as float32: allow sub-micropixel rounding,
          // not a visible size change (1e-5 CSS px is far below a display pixel).
          assert.ok(Math.abs(marker.white.width * marker.fit - 2) < 1e-5, "white stroke stays 2 visible pixels: " + JSON.stringify(marker));
          assert.ok(Math.abs(marker.black.width * marker.fit - 5) < 1e-5, "black outline stays 5 visible pixels: " + JSON.stringify(marker));
          await portrait.mouse.click(imageBox.x + width / 2, imageBox.y + height / 2);
          await portrait.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
          await portrait.evaluate(async () => document.getElementById("track").onclick());
          const measuredPoint = await portrait.evaluate(() => __qa.jobs.find(job => job.type === "track").point);
          const nativeClick = await portrait.evaluate(() => __qa.centerClick);
          const expectedFromNative = {
            x: (nativeClick.x - nativeClick.rect.x - (nativeClick.rect.width - width) / 2) / width,
            y: (nativeClick.y - nativeClick.rect.y - (nativeClick.rect.height - height) / 2) / height
          };
          assert.ok(Math.abs(measuredPoint.x - expectedFromNative.x) < 1e-10 && Math.abs(measuredPoint.y - expectedFromNative.y) < 1e-10, "pointer normalization must exactly match the native click: " + JSON.stringify({ nativeClick, measuredPoint, expectedFromNative }));
          // Native mouse coordinates are quantized to CSS pixels, so the
          // physical center click must land within one displayed pixel.
          assert.ok(Math.abs(measuredPoint.x - 0.5) <= 1 / width && Math.abs(measuredPoint.y - 0.5) <= 1 / height, JSON.stringify(measuredPoint));
          fs.writeFileSync(path.join(artifacts, `portrait-${previewWidth}x${previewHeight}-pointer.json`), JSON.stringify({ requestedClick: { x: imageBox.x + width / 2, y: imageBox.y + height / 2 }, nativeClick, displayedImage: imageBox, measuredPoint, expectedFromNative }, null, 2));
          await portrait.evaluate(() => document.getElementById("toggle-loupe").onclick());
          await portrait.mouse.move(box.x + 4, box.y + box.height / 2);
          assert.equal(await portrait.locator("#loupe").isVisible(), false, "letterbox does not show a false image sample");
          for (const [x, y] of [[.02, .02], [.98, .98]]) {
            await portrait.mouse.move(imageBox.x + width * x, imageBox.y + height * y);
            assert.equal(await portrait.locator("#loupe").isVisible(), true);
            const [loupe, viewer] = await Promise.all([portrait.locator("#loupe").boundingBox(), portrait.locator("#viewer").boundingBox()]);
            assert.ok(loupe.x >= viewer.x && loupe.y >= viewer.y && loupe.x + loupe.width <= viewer.x + viewer.width + 1 && loupe.y + loupe.height <= viewer.y + viewer.height + 1, JSON.stringify({ loupe, viewer }));
          }
          assert.equal(await portrait.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
          await portrait.screenshot({ path: path.join(artifacts, `portrait-${previewWidth}x${previewHeight}-${viewportWidth}px.png`), fullPage: true });
        } finally { await portrait.close(); }
      });
    }
    await check("no browser JS exceptions", async () => assert.deepEqual(pageErrors, []));
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(artifacts, "report.json"), JSON.stringify({ isolated: true, real: ["main.js", "core.cjs", "Chromium canvas", "synthetic MP4/audio playback"], mocked: ["CEP host", "worker IPC", "filesystem writes"], results, pageErrors }, null, 2));
    console.log("Artifacts: " + artifacts);
    console.log(results.filter(r => r.ok).length + "/" + results.length + " checks passed");
    if (results.some(r => !r.ok)) process.exitCode = 1;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
