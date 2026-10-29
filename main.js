/* FastTracker CEP: processing stays local; the original Motion is never reset. */
(function () {
  "use strict";
  var requireNode = window.cep_node ? window.cep_node.require : (typeof require === "function" ? require : null);
  var ui = {}, ids = ["load","clip-name","empty","preview","viewer","scrub","frame-label","duration","radius","radius-value","track","cancel","progress-bar","paste","stabilize","smooth","smooth-value","status","export","audio-play","step-back","step-forward","mark-in","mark-out","clear-range","range-in","range-out","waveform","waveform-wrap","range-selection","range-in-handle","range-out-handle","waveform-playhead","loupe","toggle-loupe","reset-point","clear-track","toggle-path","motion-blur","confidence","confidence-value","lost-tolerance","lost-tolerance-value","range-summary"];
  ids.forEach(function (id) { ui[id] = document.getElementById(id); });
  var fs, path, cp, os, core, root, config, hostReady = false;
  var clip = null, media = null, point = null, pointFrame = 0, result = null;
  var busy = false, busyKind = "", processJob = null, lastImage = null, imageRevision = 0;
  var currentPoint = null, trail = [], rangeActive = false, rangeStart = 0, rangeEnd = 0;
  var audio = null, player = null, playing = false, playbackRAF = 0, playbackRevision = 0, proxyFailed = false;
  var pendingFrame = null, showPath = true, showLoupe = false, lastPointer = null;
  var clipboardKey = "ponto-tracker.clipboard.v1"; // Retain the existing private clipboard.
  var canvas = ui.preview, context = canvas.getContext("2d");
  function on(node, name, fn) { if (node && node.addEventListener) node.addEventListener(name, fn); }
  function status(message, type) { ui.status.textContent = message; ui.status.className = type || ""; }
  function logFailure(stage, error) {
    // Small local diagnostic only; never media pixels, environment or uploads.
    try {
      var file = path.join(os.tmpdir(), "fasttracker-diagnostics.log");
      if (fs.existsSync(file) && fs.statSync(file).size > 65536) fs.writeFileSync(file, "", "utf8");
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), stage: stage, message: error.message || String(error), file: clip && clip.file, frame: cursor(), fps: clip && clip.fps }) + "\n", "utf8");
    } catch (ignoreDiagnostic) { /* Logging cannot block the panel. */ }
  }
  function totalFrames() { return clip ? Math.max(1, Math.ceil(clip.duration * clip.fps - 0.00001)) : 1; }
  function cursor() { return Math.max(0, Math.min(totalFrames() - 1, Number(ui.scrub.value) || 0)); }
  function sampleAt(frame) {
    if (result) for (var i = 0; i < result.samples.length; i += 1) if (result.samples[i].frame === frame) return result.samples[i];
    return null;
  }
  function selection() { return { startFrame: rangeActive ? rangeStart : 0, endFrame: rangeActive ? rangeEnd : totalFrames() - 1 }; }
  function applicationResult() {
    if (!result) return null;
    try { core.trackingOffsets(result); return result; }
    catch (incomplete) { return null; } // Never overwrite a complete host path with an incomplete buffer.
  }
  function controls() {
    var locked = busy || !clip || !media, ready = !busy && !!applicationResult();
    ui.load.disabled = busy || !hostReady; ui.scrub.disabled = !media || busy && busyKind !== "frame";
    ["radius","smooth","confidence","lost-tolerance","motion-blur"].forEach(function (id) { ui[id].disabled = busy; });
    ui.track.disabled = locked || !point || selection().endFrame <= selection().startFrame;
    ui.paste.disabled = !ready; ui.stabilize.disabled = !ready; ui.export.disabled = busy || !result; ui.cancel.hidden = !processJob;
    ["step-back","step-forward","mark-in","mark-out","clear-range","range-in","range-out","reset-point","toggle-loupe","toggle-path"].forEach(function (id) { ui[id].disabled = locked; });
    ui["clear-track"].disabled = busy || !result;
    // A restored buffer can prepare playback on demand, without re-tracking.
    ui["audio-play"].disabled = busy || !player || !media || !!(audio && !audio.videoFile && !audio.audioFile);
    ui["audio-play"].setAttribute("aria-pressed", String(playing));
    ui["audio-play"].setAttribute("aria-label", playing ? "Pausar prévia" : "Reproduzir prévia com áudio");
    ui["toggle-loupe"].setAttribute("aria-pressed", String(showLoupe));
    ui["toggle-path"].setAttribute("aria-pressed", String(showPath));
    ui["waveform-wrap"].setAttribute("aria-disabled", String(!media || busy));
  }
  function setBusy(value, kind) { busy = value; busyKind = value ? kind : ""; controls(); }
  function frameSource() {
    return player && player.videoWidth > 0 && player.readyState >= 2 && !player.seeking && busyKind !== "track" && (playing || clip && Math.abs(player.currentTime - cursor() / clip.fps) < 0.75 / clip.fps) ? player : lastImage;
  }
  function overlayUnit() {
    // Canvas pixels shrink with object-fit, especially for vertical footage.
    // Size the overlay in visible CSS pixels, not in the decoded frame pixels.
    var rect = canvas.getBoundingClientRect();
    var fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    return fit > 0 && isFinite(fit) ? 1 / fit : 1;
  }
  function contrastStroke(ctx, unit, width, color) {
    ctx.strokeStyle = "#050505"; ctx.lineWidth = (width + 3) * unit; ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = width * unit; ctx.stroke();
  }
  function drawReticle(ctx, x, y, unit) {
    ctx.save(); ctx.setLineDash([]); ctx.lineCap = "round"; ctx.lineJoin = "round";
    // 18px square + outer ticks: a precise center without a tiny hairline box.
    ctx.strokeStyle = "#050505"; ctx.lineWidth = 5 * unit;
    ctx.strokeRect(x - 9 * unit, y - 9 * unit, 18 * unit, 18 * unit);
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2 * unit;
    ctx.strokeRect(x - 9 * unit, y - 9 * unit, 18 * unit, 18 * unit);
    ctx.beginPath();
    ctx.moveTo(x - 15 * unit, y); ctx.lineTo(x - 11 * unit, y);
    ctx.moveTo(x + 11 * unit, y); ctx.lineTo(x + 15 * unit, y);
    ctx.moveTo(x, y - 15 * unit); ctx.lineTo(x, y - 11 * unit);
    ctx.moveTo(x, y + 11 * unit); ctx.lineTo(x, y + 15 * unit);
    contrastStroke(ctx, unit, 2, "#ffffff");
    ctx.beginPath(); ctx.arc(x, y, 2.8 * unit, 0, Math.PI * 2); ctx.fillStyle = "#050505"; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 1.3 * unit, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
    ctx.restore();
  }
  function redraw() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    var background = frameSource(); if (background) context.drawImage(background, 0, 0, canvas.width, canvas.height);
    var p = currentPoint || (pointFrame === cursor() ? point : sampleAt(cursor())) || point;
    var unit = overlayUnit(); context.save(); context.lineCap = "round"; context.lineJoin = "round";
    if (showPath && trail.length > 1) {
      context.beginPath(); trail.forEach(function (v, i) { if (i) context.lineTo(v.x * canvas.width, v.y * canvas.height); else context.moveTo(v.x * canvas.width, v.y * canvas.height); }); contrastStroke(context, unit, 2, "#7acbff");
    }
    if (p) {
      var x = p.x * canvas.width, y = p.y * canvas.height, r = Number(ui.radius.value);
      // Keep the search region's actual geometry; only its stroke is enlarged.
      context.setLineDash([6 * unit, 4 * unit]);
      context.strokeStyle = "#050505"; context.lineWidth = 4 * unit; context.strokeRect(x - r, y - r, r * 2, r * 2);
      context.strokeStyle = "#7acbff"; context.lineWidth = 1.5 * unit; context.strokeRect(x - r, y - r, r * 2, r * 2); context.setLineDash([]);
      drawReticle(context, x, y, unit);
    }
    context.restore();
    drawLoupe();
  }
  function image(base64, requestedFrame) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), revision = ++imageRevision;
      img.onload = function () { if (revision === imageRevision && (requestedFrame === undefined || requestedFrame === cursor())) { lastImage = img; redraw(); } resolve(); };
      img.onerror = function () { reject(new Error("Falha ao mostrar o preview.")); };
      img.src = "data:image/jpeg;base64," + base64;
    });
  }
  function canvasPoint(event) {
    var rect = canvas.getBoundingClientRect(), fit = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    var w = canvas.width * fit, h = canvas.height * fit;
    var x = (event.clientX - rect.left - (rect.width - w) / 2) / w, y = (event.clientY - rect.top - (rect.height - h) / 2) / h;
    return x >= 0 && y >= 0 && x <= 1 && y <= 1 ? { x: x, y: y } : null;
  }
  function drawLoupe() {
    var loupe = ui.loupe, visible = showLoupe && lastPointer && media && !busy;
    loupe.hidden = !visible; if (!visible) return;
    var ctx = loupe.getContext("2d"), p = lastPointer.point;
    loupe.width = 144; loupe.height = 144;
    ctx.clearRect(0, 0, 144, 144); ctx.save(); ctx.beginPath(); ctx.arc(72, 72, 70, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "#101010"; ctx.fillRect(0, 0, 144, 144); ctx.imageSmoothingEnabled = false;
    var source = frameSource();
    if (source) { var sw = source.videoWidth || source.naturalWidth || canvas.width, sh = source.videoHeight || source.naturalHeight || canvas.height; ctx.drawImage(source, p.x * sw - 20, p.y * sh - 20, 40, 40, 0, 0, 144, 144); }
    var loupeRect = loupe.getBoundingClientRect(), loupeFit = Math.min(loupeRect.width / 144, loupeRect.height / 144);
    drawReticle(ctx, 72, 72, loupeFit > 0 ? 1 / loupeFit : 1); ctx.restore();
    var rect = ui.viewer.getBoundingClientRect();
    loupe.style.left = Math.max(4, Math.min(rect.width - 144, lastPointer.clientX - rect.left + 18)) + "px";
    loupe.style.top = Math.max(4, Math.min(rect.height - 144, lastPointer.clientY - rect.top - 144)) + "px";
  }
  function frameLabel(frame) {
    var fps = clip ? clip.fps : 30, seconds = frame / fps;
    ui["frame-label"].textContent = String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(Math.floor(seconds % 60)).padStart(2, "0") + ":" + String(Math.floor(frame % fps)).padStart(2, "0");
    ui["waveform-wrap"].setAttribute("aria-valuenow", String(frame)); ui["waveform-wrap"].setAttribute("aria-valuemax", String(totalFrames() - 1)); drawWaveform();
  }
  function drawWaveform() {
    var graph = ui.waveform, rect = graph.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
    var w = Math.max(100, Math.round(rect.width || 600)), h = Math.max(30, Math.round(rect.height || 72));
    graph.width = Math.round(w * ratio); graph.height = Math.round(h * ratio);
    var ctx = graph.getContext("2d"); ctx.scale(ratio, ratio); ctx.clearRect(0, 0, w, h); ctx.fillStyle = "#111111"; ctx.fillRect(0, 0, w, h);
    var peaks = audio && Array.isArray(audio.waveform) ? audio.waveform : [], bars = Math.floor(w / 4); ctx.fillStyle = "#3f8258";
    for (var i = 0; i < bars; i += 1) { var a = peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(i * peaks.length / bars))] : 0; var bh = Math.max(1, Math.min(1, Math.max(0, a)) * (h - 12)); ctx.fillRect(i * 4 + 1, h - bh - 4, 2, bh); }
    if (!peaks.length) { ctx.fillStyle = "#8e8e8e"; ctx.font = "10px sans-serif"; ctx.fillText(audio && audio.audioError ? "Áudio indisponível" : audio && audio.hasAudio === false ? "Clipe sem áudio" : media ? "Play prepara a prévia de áudio" : "Carregue um clipe", 10, 16); }
    var max = Math.max(1, totalFrames() - 1), start = rangeStart / max * 100, end = rangeEnd / max * 100;
    ui["range-selection"].hidden = !rangeActive; ui["range-selection"].style.left = start + "%"; ui["range-selection"].style.width = (end - start) + "%";
    ["range-in-handle","range-out-handle"].forEach(function (id, n) { ui[id].hidden = !rangeActive; ui[id].style.left = (n ? end : start) + "%"; ui[id].setAttribute("aria-valuenow", String(n ? rangeEnd : rangeStart)); ui[id].setAttribute("aria-valuemax", String(max)); });
    if (result) { ctx.fillStyle = "#81b8f4"; result.samples.forEach(function (p) { ctx.fillRect(p.frame / Math.max(1, totalFrames()) * w, 1, Math.max(1, w / totalFrames()), 2); }); }
    ui["waveform-playhead"].style.left = cursor() / max * 100 + "%";
    ui["range-summary"].textContent = rangeActive ? "In " + rangeStart + " — Out " + rangeEnd + " · " + (rangeEnd - rangeStart + 1) + " frames" : clip ? "Clipe inteiro · " + totalFrames() + " frames" : "Sem intervalo";
  }
  function setRange(start, end, enabled) {
    var max = totalFrames() - 1;
    rangeStart = Math.max(0, Math.min(max - 1, Math.round(start) || 0)); rangeEnd = Math.max(rangeStart + 1, Math.min(max, Math.round(end) || 0)); rangeActive = !!enabled;
    ui["range-in"].value = rangeStart; ui["range-in"].max = Math.max(0, max - 1); ui["range-out"].value = rangeEnd; ui["range-out"].max = max;
    drawWaveform(); controls(); remember();
  }
  function normalizeResult(value) {
    if (!value || !Array.isArray(value.samples) || value.samples.length < 1 || value.samples.length > 3600) throw new Error("Tracking local inválido.");
    if (!value.schema || value.schema === 1) {
      value.source = Object.assign({}, value.source || {}, { file: clip.file, inSeconds: clip.inSeconds, duration: clip.duration, fps: clip.fps });
      value.totalFrames = totalFrames(); value.range = { startFrame: value.samples[0].frame, endFrame: value.samples[value.samples.length - 1].frame };
    }
    return value;
  }
  function remember() {
    try {
      if (!window.localStorage) return;
      if (!clip || !media || !result) { window.localStorage.removeItem(clipboardKey); return; }
      var still = lastImage && typeof lastImage.src === "string" && lastImage.src.indexOf("data:image/") === 0 ? lastImage.src : null;
      window.localStorage.setItem(clipboardKey, JSON.stringify({ clip: clip, media: Object.assign({}, media, { image: null }), point: point, pointFrame: pointFrame, result: result, scrub: cursor(), smooth: ui.smooth.value, motionBlur: !!ui["motion-blur"].checked, rangeActive: rangeActive, rangeStart: rangeStart, rangeEnd: rangeEnd, preview: still }));
    } catch (ignoreStorage) { /* Live buffer remains available when storage is full. */ }
  }
  function restore() {
    try {
      var saved = JSON.parse(window.localStorage && window.localStorage.getItem(clipboardKey) || "null");
      if (!saved || !saved.clip || !saved.media || !saved.result) return false;
      clip = saved.clip; media = saved.media;
      if (!(clip.duration > 0 && clip.duration <= 60.01 && clip.fps >= 1 && clip.fps <= 120) || totalFrames() > 3600) throw new Error("Dados locais incompatíveis.");
      result = normalizeResult(saved.result); point = saved.point || result.samples[0]; pointFrame = saved.pointFrame || 0;
      canvas.width = media.previewWidth; canvas.height = media.previewHeight;
      ui["clip-name"].textContent = clip.name; ui["clip-name"].title = clip.file; ui.duration.textContent = clip.duration.toFixed(2) + "s";
      ui.scrub.max = totalFrames() - 1; ui.scrub.value = Math.min(totalFrames() - 1, saved.scrub || 0); ui.smooth.value = saved.smooth || 0; ui["motion-blur"].checked = !!saved.motionBlur;
      ui.empty.style.display = "none"; trail = result.samples.slice(); currentPoint = sampleAt(cursor());
      setRange(saved.rangeStart || 0, saved.rangeEnd === undefined ? totalFrames() - 1 : saved.rangeEnd, saved.rangeActive);
      if (saved.preview) image(saved.preview.split(",")[1]).catch(function () {});
      frameLabel(cursor()); controls(); status("Tracking restaurado. PASTE TRACK / STABILIZE disponíveis; Play prepara o áudio.", "success"); return true;
    } catch (ignoreRestore) { clip = null; media = null; result = null; point = null; return false; }
  }
  function host(method, args) {
    return new Promise(function (resolve, reject) {
      if (!window.__adobe_cep__) { reject(new Error("Abra este painel dentro do Premiere Pro.")); return; }
      var text = "PontoTracker." + method + "(" + (args === undefined ? "" : JSON.stringify(args).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")) + ")";
      window.__adobe_cep__.evalScript(text, function (raw) { try { var value = JSON.parse(raw); if (!value.ok) throw new Error(value.error); resolve(value); } catch (error) { reject(error); } });
    });
  }
  function worker(task) {
    return new Promise(function (resolve, reject) {
      var child = cp.fork(path.join(root, "engine", "worker.cjs"), [], { execPath: config.node, execArgv: [], windowsHide: true, silent: true }), settled = false, log = "", timeout;
      processJob = child; controls();
      function done(error, value) { if (settled) return; settled = true; clearTimeout(timeout); processJob = null; controls(); if (error) reject(error); else resolve(value); }
      timeout = setTimeout(function () { if (child.connected) child.send({ type: "cancel" }); done(new Error("Processamento excedeu 10 minutos; dados anteriores preservados.")); }, 600000);
      child.stderr.on("data", function (chunk) { log = (log + chunk.toString()).slice(-1500); });
      child.on("message", function (message) {
        if (settled) return;
        if (message.type === "error") done(new Error(message.message));
        if (message.type === "done") done(null, message.result);
        if (message.type === "progress") {
          currentPoint = message.point; ui.scrub.value = String(message.frame); frameLabel(message.frame);
          if (message.point) trail.push(Object.assign({ frame: message.frame }, message.point));
          ui["progress-bar"].style.width = Math.round(message.progress * 100) + "%";
          status("Rastreando · " + Math.round(message.progress * 100) + "% · confiança " + Math.round(message.confidence * 100) + "%");
          if (message.image) image(message.image).catch(function () {});
        }
      });
      // CEP can deliver exit before the last IPC message/stderr has drained.
      // Only close is terminal; a preview already in transit must still win.
      child.on("error", function (error) { done(error); });
      child.on("close", function (code, signal) {
        if (!settled) done(new Error("O motor de mídia encerrou sem resultado (" + (signal ? "sinal " + signal : "código " + code) + ")." + (log ? " " + log : "")));
      });
      child.send(task, function (error) { if (error) done(error); });
    });
  }
  function job(type) {
    var range = selection();
    return { type: type, file: clip.file, config: config, inSeconds: clip.inSeconds, duration: clip.duration, fps: clip.fps, referenceFrame: cursor(), startFrame: range.startFrame, endFrame: range.endFrame, point: currentPoint || point, radius: Number(ui.radius.value), confidenceThreshold: Number(ui.confidence.value), lostTolerance: Number(ui["lost-tolerance"].value) };
  }
  async function frame(throwOnError) {
    if (!clip) return; var requested = cursor();
    if (busy) { if (busyKind === "frame") pendingFrame = requested; return; } setBusy(true, "frame");
    try {
      var data = await worker(job("frame"));
      if (!data || !(data.previewWidth > 0 && data.previewHeight > 0) || typeof data.image !== "string" || !data.image) throw new Error("O decoder não retornou uma imagem válida do frame solicitado.");
      canvas.width = data.previewWidth; canvas.height = data.previewHeight;
      await image(data.image, requested); media = data; currentPoint = pointFrame === cursor() ? point : sampleAt(cursor()); trail = result ? result.samples.slice() : []; redraw(); frameLabel(cursor());
    } catch (error) { logFailure("frame", error); status(error.message, "error"); if (throwOnError) throw error; }
    finally { setBusy(false); if (pendingFrame !== null) { pendingFrame = null; frame(); } }
  }
  function fileURL(file) { return "file:///" + encodeURI(file.replace(/\\/g, "/").replace(/^\/+/, "")).replace(/#/g, "%23").replace(/\?/g, "%3F"); }
  function stopPlayback() { playbackRevision += 1; playing = false; if (player) player.pause(); if (playbackRAF) window.cancelAnimationFrame(playbackRAF); playbackRAF = 0; controls(); }
  function cleanAudio() {
    stopPlayback(); if (player) { player.removeAttribute("src"); player.load(); }
    if (audio && audio.cacheDir && fs) {
      var dir = path.resolve(audio.cacheDir), temp = path.resolve(os.tmpdir()) + path.sep;
      if (dir.indexOf(temp) === 0 && /^fasttracker-(?:audio|preview)-[a-zA-Z0-9_-]+$/.test(path.basename(dir))) {
        [audio.audioFile, audio.videoFile].forEach(function (file) { try { if (file && path.dirname(path.resolve(file)) === dir && /^(audio\.wav|preview\.mp4)$/.test(path.basename(file))) fs.unlinkSync(file); } catch (ignoreFile) {} });
        try { fs.rmdirSync(dir); } catch (ignoreDir) {}
      }
    }
    audio = null; proxyFailed = false;
  }
  async function prepareAudio() {
    if (!clip || busy) return; setBusy(true, "audio"); status("Preparando prévia e waveform do áudio…");
    try {
      audio = await worker(job("audio")); proxyFailed = false;
      if (audio.videoFile || audio.audioFile) { player.src = fileURL(audio.videoFile || audio.audioFile); player.load(); }
      drawWaveform(); status(!audio.videoFile && !audio.audioFile ? "Prévia de áudio/vídeo indisponível neste arquivo. Tracking e seleção de frames continuam disponíveis." : audio.audioError ? "Waveform indisponível. O tracking continua disponível." : audio.proxyError ? "Prévia de áudio pronta; vídeo disponível frame a frame." : audio.hasAudio ? "Prévia pronta. Espaço reproduz; I e O marcam o trecho." : "Prévia pronta. Este arquivo de vídeo não contém áudio.", audio.audioError || audio.proxyError ? "warning" : "");
    } catch (error) { status("Áudio indisponível: " + error.message + " O tracking continua disponível.", "warning"); }
    finally { setBusy(false); }
  }
  function seek(value, decode) {
    if (!media || busy && busyKind !== "frame") return;
    value = Math.max(0, Math.min(totalFrames() - 1, Math.round(value))); stopPlayback(); ui.scrub.value = value; currentPoint = pointFrame === value ? point : sampleAt(value); frameLabel(value);
    if (audio && (audio.videoFile || audio.audioFile)) { try { player.currentTime = value / clip.fps; } catch (ignoreSeek) {} }
    redraw(); if (decode !== false) return frame();
  }
  function playbackTick() {
    if (!playing || !player || !clip) return;
    var value = Math.min(totalFrames() - 1, Math.floor(player.currentTime * clip.fps + 0.0001));
    ui.scrub.value = value; currentPoint = sampleAt(value) || (pointFrame === value ? point : null); frameLabel(value); redraw();
    if (player.ended || value >= selection().endFrame) { stopPlayback(); return; }
    playbackRAF = window.requestAnimationFrame(playbackTick);
  }
  async function playPreview() {
    if (busy || !clip || !player) return; if (playing) { stopPlayback(); return; }
    if (!audio) { await prepareAudio(); if (!audio || !(audio.videoFile || audio.audioFile)) return; }
    var revision = ++playbackRevision;
    try {
      var range = selection(), value = cursor(); if (value < range.startFrame || value >= range.endFrame) value = range.startFrame;
      player.currentTime = value / clip.fps; await player.play();
      // A delayed play() promise must not restart playback after Track, Load,
      // seek, visibility change, or an explicit pause has already stopped it.
      if (revision !== playbackRevision || busy || document.hidden) { if (!playing) player.pause(); return; }
      playing = true; controls(); playbackTick();
    } catch (error) { if (revision !== playbackRevision) return; stopPlayback(); status("Não foi possível reproduzir esta prévia: " + error.message, "error"); }
  }
  ui.load.onclick = async function () {
    if (busy || !hostReady) return;
    cleanAudio(); clip = null; media = null; point = null; result = null; remember(); lastImage = null; currentPoint = null; trail = []; imageRevision += 1;
    ui["clip-name"].textContent = "Carregando seleção…"; ui.empty.style.display = "flex"; redraw(); setBusy(true, "load"); status("Lendo o clipe selecionado…");
    try {
      clip = (await host("capture")).clip;
      if (clip.duration > 60.01 || totalFrames() > 3600) throw new Error("Use um clipe de até 60 segundos / 3.600 frames nesta versão.");
      if (totalFrames() < 2) throw new Error("O clipe precisa ter pelo menos dois frames.");
      ui["clip-name"].textContent = clip.name; ui["clip-name"].title = clip.file; ui.scrub.max = totalFrames() - 1; ui.scrub.value = 0; ui.duration.textContent = clip.duration.toFixed(2) + "s";
      rangeActive = false; rangeStart = 0; rangeEnd = totalFrames() - 1; ui.empty.style.display = "none"; ui["progress-bar"].style.width = "0%";
      setBusy(false); await frame(true); setRange(0, totalFrames() - 1, false);
      if (!media) throw new Error("O decoder não retornou o preview do clipe.");
      await prepareAudio(); status("Clique no detalhe a seguir. Sem In/Out, o tracking cobre o clipe inteiro.");
    } catch (error) { logFailure("load", error); clip = null; media = null; status(error.message, "error"); ui["clip-name"].textContent = "Nenhum clipe carregado"; ui.empty.style.display = "flex"; }
    finally { setBusy(false); }
  };
  canvas.onclick = function (event) {
    if (busy || !media) return; stopPlayback(); var p = canvasPoint(event); if (!p) return;
    point = p; pointFrame = cursor(); currentPoint = null; redraw(); remember(); controls();
    status(result ? "Novo ponto marcado. Rastreie o In/Out para corrigir o trecho; o resto será mantido." : "Ponto marcado. Clique em Rastrear.");
  };
  on(canvas, "mousemove", function (event) { var p = canvasPoint(event); lastPointer = p ? { point: p, clientX: event.clientX, clientY: event.clientY } : null; drawLoupe(); });
  on(canvas, "mouseleave", function () { lastPointer = null; drawLoupe(); });
  // Start/queue decoding immediately. While waiting, point placement and Track
  // stay locked, so a click cannot bind an old displayed image to a new frame.
  ui.scrub.oninput = function () { return seek(cursor()); };
  ui.scrub.onchange = function () { return seek(cursor()); };
  ui.radius.oninput = function () { ui["radius-value"].textContent = ui.radius.value; redraw(); };
  ["smooth","confidence","lost-tolerance"].forEach(function (id) { ui[id].oninput = function () { ui[id + "-value"].textContent = ui[id].value; remember(); controls(); }; });
  ui["motion-blur"].onchange = remember;
  ui["toggle-loupe"].onclick = function () { showLoupe = !showLoupe; controls(); drawLoupe(); };
  ui["toggle-path"].onclick = function () { showPath = !showPath; controls(); redraw(); };
  ui["reset-point"].onclick = function () { if (busy || !media) return; stopPlayback(); point = { x: 0.5, y: 0.5 }; pointFrame = cursor(); currentPoint = null; redraw(); controls(); remember(); status("Ponto recentralizado. O tracking salvo foi mantido."); };
  ui["clear-track"].onclick = function () { if (busy) return; result = null; trail = []; currentPoint = null; remember(); redraw(); drawWaveform(); controls(); status("Tracking local limpo. Nenhum efeito foi removido da timeline."); };
  ui["mark-in"].onclick = function () { setRange(cursor(), Math.max(rangeEnd, cursor() + 1), true); };
  ui["mark-out"].onclick = function () { setRange(Math.min(rangeStart, cursor() - 1), cursor(), true); };
  ui["clear-range"].onclick = function () { setRange(0, totalFrames() - 1, false); };
  ui["range-in"].onchange = function () { setRange(Number(ui["range-in"].value), rangeEnd, true); };
  ui["range-out"].onchange = function () { setRange(rangeStart, Number(ui["range-out"].value), true); };
  ui["step-back"].onclick = function () { return seek(cursor() - 1); }; ui["step-forward"].onclick = function () { return seek(cursor() + 1); }; ui["audio-play"].onclick = playPreview;
  function waveformFrame(event) { var r = ui["waveform-wrap"].getBoundingClientRect(); return Math.round(Math.max(0, Math.min(1, (event.clientX - r.left) / r.width)) * (totalFrames() - 1)); }
  var draggingRange = null;
  on(ui["waveform-wrap"], "pointerdown", function (event) {
    if (busy || !media || event.button && event.button !== 0) return;
    var id = event.target.id; if (id === "range-in-handle" || id === "range-out-handle") { draggingRange = id; event.preventDefault(); } else seek(waveformFrame(event));
  });
  on(document, "pointermove", function (event) { if (!draggingRange || busy) return; var value = waveformFrame(event); setRange(draggingRange === "range-in-handle" ? Math.min(value, rangeEnd - 1) : rangeStart, draggingRange === "range-out-handle" ? Math.max(value, rangeStart + 1) : rangeEnd, true); });
  on(document, "pointerup", function () { draggingRange = null; });
  ["range-in-handle","range-out-handle"].forEach(function (id) { on(ui[id], "keydown", function (event) { if (busy || !media || !/^Arrow(Left|Right)$/.test(event.key)) return; event.preventDefault(); event.stopPropagation(); var delta = event.key === "ArrowLeft" ? -1 : 1; setRange(id === "range-in-handle" ? Math.min(rangeStart + delta, rangeEnd - 1) : rangeStart, id === "range-out-handle" ? Math.max(rangeEnd + delta, rangeStart + 1) : rangeEnd, true); }); });
  on(document, "keydown", function (event) {
    var target = event.target || {}, tag = String(target.tagName || "").toLowerCase();
    if (event.ctrlKey || event.metaKey || event.altKey || target.isContentEditable || /input|textarea|select|button|summary/.test(tag) || /range-.*-handle/.test(target.id || "") || !media || busy) return;
    if (event.key === " " || event.code === "Space") { event.preventDefault(); playPreview(); }
    if (event.key === "i" || event.key === "I") { event.preventDefault(); ui["mark-in"].onclick(); }
    if (event.key === "o" || event.key === "O") { event.preventDefault(); ui["mark-out"].onclick(); }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); seek(cursor() + (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 10 : 1)); }
  });
  ui.track.onclick = async function () {
    if (busy || !point || !media) return; var range = selection();
    if (cursor() < range.startFrame || cursor() > range.endFrame) { status("Coloque o cursor dentro do In/Out e marque o ponto nesse frame.", "error"); return; }
    stopPlayback(); var previous = result, task = job("track"); setBusy(true, "track"); trail = []; status("Preparando rastreamento…");
    try {
      var tracked = normalizeResult(await worker(task)); result = previous && rangeActive ? core.mergeTracking(previous, tracked) : tracked;
      trail = result.samples.slice(); currentPoint = sampleAt(cursor()); redraw(); remember();
      if (!applicationResult()) status("Tracking parcial mantido. Marque In/Out incluindo um frame válido e corrija o trecho perdido.", "warning");
      else { ui["progress-bar"].style.width = "100%"; status(previous && rangeActive ? "Trecho corrigido. O tracking fora do In/Out foi preservado." : "Tracking pronto. Use PASTE TRACK ou STABILIZE.", "success"); }
    } catch (error) { result = previous; trail = result ? result.samples.slice() : []; status(error.message + (previous ? " Tracking anterior preservado." : ""), "error"); }
    finally { setBusy(false); redraw(); drawWaveform(); remember(); }
  };
  ui.cancel.onclick = function () { if (processJob && processJob.connected) { processJob.send({ type: "cancel" }); status("Cancelando; tracking anterior preservado…"); } };
  async function apply(mode) {
    var chosen = applicationResult(); if (busy || !chosen) return;
    stopPlayback(); setBusy(true, "apply"); status("Gravando e conferindo os keyframes no Premiere…"); var payloadFile;
    try {
      var targets = [], prepared = await host(mode === "stabilize" ? "prepareStabilize" : "preparePaste", clip), source = prepared.source || clip, dimensions, target, i;
      if (mode === "stabilize") targets.push({ target: source, width: chosen.source.width, height: chosen.source.height, pixelAspectRatio: source.pixelAspectRatio || chosen.source.pixelAspectRatio || 1, points: core.trackingOffsets(chosen, Number(ui.smooth.value)) });
      else for (i = 0; i < prepared.targets.length; i += 1) {
        target = prepared.targets[i];
        dimensions = target.canvasMedia ? { width: target.canvasWidth || target.sequenceWidth, height: target.canvasHeight || target.sequenceHeight, pixelAspectRatio: target.canvasPixelAspectRatio || target.sequencePixelAspectRatio || 1 } : await worker({ type: "probe", file: target.file, config: config });
        var targetPar = dimensions.pixelAspectRatio || 1;
        if (!target.canvasMedia && target.pixelAspectRatio !== null && target.pixelAspectRatio !== undefined) {
          targetPar = core.aspectRatio(target.pixelAspectRatio);
          if (dimensions.rotation === 90 || dimensions.rotation === 270) targetPar = 1 / targetPar;
        }
        targets.push({ target: target, width: dimensions.width, height: dimensions.height, pixelAspectRatio: targetPar, points: core.transferFrames(chosen, source, target, Number(ui.smooth.value)) });
      }
      var dir = fs.mkdtempSync(path.join(os.tmpdir(), "fasttracker-apply-")); payloadFile = path.join(dir, "apply.json");
      fs.writeFileSync(payloadFile, JSON.stringify({ source: source, sourceSize: chosen.source, mode: mode, motionBlur: !!ui["motion-blur"].checked, targets: targets }), { encoding: "utf8", mode: 384 });
      var receipt = await host("applyFromFile", payloadFile), warnings = [];
      (receipt.targets || []).forEach(function (t) { if (t.motionBlur && t.motionBlur.applied === false && t.motionBlur.warning) warnings.push(t.motionBlur.warning); });
      status((mode === "stabilize" ? "STABILIZE aplicado no vídeo importado." : "PASTE TRACK aplicado em " + receipt.targets.length + " destino(s).") + (chosen !== result ? " Apenas o In/Out válido foi aplicado." : "") + (warnings.length ? " " + warnings.join(" ") : ""), warnings.length ? "warning" : "success");
    } catch (error) { status(error.message + " Tracking mantido; você pode tentar novamente.", "error"); }
    finally { if (payloadFile) { try { fs.unlinkSync(payloadFile); fs.rmdirSync(path.dirname(payloadFile)); } catch (ignoreCleanup) {} } setBusy(false); remember(); }
  }
  ui.paste.onclick = function () { return apply("paste"); }; ui.stabilize.onclick = function () { return apply("stabilize"); };
  ui.export.onclick = function () {
    if (!result || !window.cep || !window.cep.fs) return;
    var dialog = window.cep.fs.showSaveDialogEx("Salvar tracking JSON", os.homedir(), ["json"], "fasttracker.json"); if (dialog.err || !dialog.data) return;
    try { fs.writeFileSync(dialog.data, JSON.stringify({ clip: clip, tracking: result }, null, 2), "utf8"); status("Tracking exportado em JSON.", "success"); } catch (error) { status(error.message, "error"); }
  };
  on(window, "resize", function () { redraw(); drawWaveform(); }); on(document, "visibilitychange", function () { if (document.hidden) stopPlayback(); else redraw(); });
  on(window, "beforeunload", function () { remember(); if (processJob && processJob.connected) processJob.send({ type: "cancel" }); cleanAudio(); });
  try {
    if (!requireNode) throw new Error("Abra pelo Premiere: Janela > Extensões > FastTracker.");
    fs = requireNode("fs"); path = requireNode("path"); cp = requireNode("child_process"); os = requireNode("os");
    root = decodeURIComponent(location.pathname); if (/^\/[A-Za-z]:/.test(root)) root = root.slice(1); root = path.dirname(root); core = requireNode(path.join(root, "core.cjs"));
    if (typeof core.mergeTracking !== "function" || typeof core.resolveRuntime !== "function") throw new Error("Feche e reabra o painel para carregar o FastTracker 0.5.1.");
    config = core.resolveRuntime(JSON.parse(fs.readFileSync(path.join(root, "runtime.json"), "utf8")),root,path);
    if (![config.node, config.ffmpeg, config.ffprobe].every(function (p) { return p && fs.existsSync(p); })) throw new Error("Runtime incompleto. Execute INSTALAR.command no macOS ou INSTALAR.bat no Windows.");
    player = document.createElement("video"); player.preload = "auto"; player.playsInline = true; player.style.display = "none"; document.body.appendChild(player);
    on(player, "seeked", redraw); on(player, "ended", stopPlayback);
    on(player, "error", function () { if (!proxyFailed && audio && audio.audioFile && player.src !== fileURL(audio.audioFile)) { proxyFailed = true; stopPlayback(); player.src = fileURL(audio.audioFile); player.load(); status("Vídeo não suportado neste CEP. Áudio e seleção de frames continuam disponíveis.", "warning"); } });
    if (window.__adobe_cep__) {
      var hostPath = path.join(root, "host", "bridge.jsx").replace(/\\/g, "/");
      window.__adobe_cep__.evalScript("$.evalFile(" + JSON.stringify(hostPath) + "); PontoTracker.version", function (version) {
        if (version === "0.5.1") { hostReady = true; if (!restore()) status("Selecione um vídeo na timeline e carregue o clipe."); controls(); }
        else { status("Reabra o painel para atualizar o conector do FastTracker.", "error"); controls(); }
      });
    }
  } catch (error) { hostReady = false; status(error.message, "error"); }
  controls(); drawWaveform();
}());
