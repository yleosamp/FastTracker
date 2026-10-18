"use strict";

function trackingBounds(result) {
  if (!result || !Array.isArray(result.samples) || result.samples.length > 3600) throw new Error("Tracking incompleto ou inválido.");
  let previous = -1;
  for (const sample of result.samples) {
    if (!sample || !Number.isInteger(sample.frame) || sample.frame < 0 || sample.frame <= previous || !Number.isFinite(sample.x) || !Number.isFinite(sample.y) || Math.abs(sample.x) > 16 || Math.abs(sample.y) > 16) throw new Error("Tracking incompleto: frames ou posições inválidos.");
    previous = sample.frame;
  }
  const first = result.samples[0], last = result.samples[result.samples.length - 1];
  const range = result.range || { startFrame: first && first.frame, endFrame: last && last.frame };
  if (!Number.isInteger(range.startFrame) || !Number.isInteger(range.endFrame) || range.startFrame < 0 || range.endFrame < range.startFrame || range.endFrame - range.startFrame >= 3600) throw new Error("Intervalo de tracking inválido.");
  if (first && (first.frame < range.startFrame || last.frame > range.endFrame)) throw new Error("Frames fora do intervalo de tracking.");
  if (result.totalFrames !== undefined && (!Number.isInteger(result.totalFrames) || result.totalFrames < 1 || result.totalFrames > 3600 || range.endFrame >= result.totalFrames)) throw new Error("Duração de tracking inválida.");
  return { startFrame: range.startFrame, endFrame: range.endFrame };
}

function missingRanges(samples, range) {
  const missing = [];
  let frame = range.startFrame;
  for (const sample of samples) {
    if (sample.frame > frame) missing.push({ startFrame: frame, endFrame: sample.frame - 1 });
    frame = sample.frame + 1;
  }
  if (frame <= range.endFrame) missing.push({ startFrame: frame, endFrame: range.endFrame });
  return missing;
}

// Explicit I/O can deliberately select a complete part of a partial analysis.
// No interpolation, duplicated endpoint, or invented sample fills a missing frame.
function selectTrackingRange(result, startFrame, endFrame) {
  const bounds = trackingBounds(result);
  if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || startFrame < bounds.startFrame || endFrame > bounds.endFrame || endFrame < startFrame) throw new Error("Selecione um In/Out dentro do intervalo analisado.");
  const range = { startFrame, endFrame };
  const samples = result.samples.filter(sample => sample.frame >= startFrame && sample.frame <= endFrame).map(sample => ({ ...sample }));
  const missing = missingRanges(samples, range);
  if (missing.length || samples.length < 2) throw new Error("Tracking incompleto nesse In/Out. Reanalise os frames que faltam antes de aplicar.");
  return { ...result, range, samples, missing, lost: false, truncated: false };
}

function trackingOffsets(result, smoothing = 0) {
  const range = trackingBounds(result);
  if (result.lost || result.truncated || result.samples.length < 2 || missingRanges(result.samples, range).length) throw new Error("Tracking incompleto. Analise novamente antes de aplicar.");
  if (!Number.isFinite(smoothing)) throw new Error("Suavização inválida.");
  const samples = result.samples;
  const radius = Math.max(0, Math.min(8, Math.round(smoothing)));
  const averaged = samples.map((p, i) => {
    let x = 0, y = 0, count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(samples.length - 1, i + radius); j += 1) {
      x += samples[j].x; y += samples[j].y; count += 1;
    }
    return { frame: p.frame, x: x / count, y: y / count };
  });
  return averaged.map(p => ({ frame: p.frame, dx: p.x - averaged[0].x, dy: p.y - averaged[0].y }));
}

function sourceIdentity(result) {
  const source = result && result.source;
  if (!source || typeof source.file !== "string" || !source.file || ![source.width, source.height, source.inSeconds, source.duration, source.fps].every(Number.isFinite) || source.width <= 0 || source.height <= 0 || source.inSeconds < 0 || source.duration <= 0 || source.fps < 1 || source.fps > 120) throw new Error("A origem do tracking não pôde ser conferida. Carregue o clipe novamente.");
  const totalFrames = Math.ceil(source.duration * source.fps - 0.00001);
  if (totalFrames < 1 || totalFrames > 3600 || result.totalFrames !== totalFrames || !Number.isFinite(result.fps) || Math.abs(result.fps - source.fps) > 1e-8) throw new Error("Duração/fps da origem não corresponde ao tracking.");
  // Windows paths are case-insensitive; POSIX paths are not.
  let file = source.file.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(file)) file = file.toLowerCase();
  return { file, width: source.width, height: source.height, inSeconds: source.inSeconds, duration: source.duration, fps: source.fps, pixelAspectRatio: aspectRatio(source.pixelAspectRatio), revision: source.revision };
}

function sameSource(previous, replacement) {
  const a = sourceIdentity(previous), b = sourceIdentity(replacement);
  if (a.file !== b.file || a.width !== b.width || a.height !== b.height || Math.abs(a.inSeconds - b.inSeconds) > 1e-7 || Math.abs(a.duration - b.duration) > 1e-7 || Math.abs(a.fps - b.fps) > 1e-8 || Math.abs(a.pixelAspectRatio - b.pixelAspectRatio) > 1e-8 || (a.revision !== undefined && b.revision !== undefined && a.revision !== b.revision)) throw new Error("O arquivo ou intervalo de origem mudou. Carregue e analise novamente.");
}

// Replacement samples retain their measured motion but are translated to an
// existing common frame, so selecting a different detail on the same object
// does not create an arbitrary positional jump. Outside I/O is never edited.
function mergeTracking(previous, replacement, options = {}) {
  const freshRange = trackingBounds(replacement);
  sourceIdentity(replacement);
  if (!replacement.samples.length) throw new Error("Nenhum frame válido foi rastreado.");
  if (!previous) {
    const samples = replacement.samples.map(sample => ({ ...sample }));
    const missing = missingRanges(samples, freshRange);
    return { ...replacement, samples, range: freshRange, missing, lost: !!missing.length, truncated: !!missing.length };
  }
  const oldRange = trackingBounds(previous);
  sameSource(previous, replacement);
  const existing = new Map(previous.samples.map(sample => [sample.frame, sample]));
  const common = replacement.samples.filter(sample => existing.has(sample.frame));
  if (!common.length) throw new Error("Para acrescentar o trecho, inclua no In/Out pelo menos um frame já rastreado e válido.");
  // Prefer the shared reference, otherwise the shared frame nearest the
  // beginning of the repaired region. The offset is constant, not a fabricated
  // per-frame path or an interpolation over tracking failures.
  const anchor = common.find(sample => sample.frame === replacement.referenceFrame) || common[0];
  const oldAnchor = existing.get(anchor.frame);
  const dx = oldAnchor.x - anchor.x, dy = oldAnchor.y - anchor.y;
  const corrected = replacement.samples.map(sample => ({ ...sample, x: sample.x + dx, y: sample.y + dy }));
  const correctedMap = new Map(corrected.map(sample => [sample.frame, sample]));
  const dimensions = { width: replacement.width || replacement.source.width, height: replacement.height || replacement.source.height };
  const distance = (a, b) => Math.hypot((a.x - b.x) * dimensions.width, (a.y - b.y) * dimensions.height);
  let seamErrorPixels = 0;
  for (const edge of [freshRange.startFrame, freshRange.endFrame]) {
    if (correctedMap.has(edge) && existing.has(edge)) seamErrorPixels = Math.max(seamErrorPixels, distance(correctedMap.get(edge), existing.get(edge)));
  }
  const maxSeamPixels = options.maxSeamPixels === undefined ? 12 : options.maxSeamPixels;
  if (!Number.isFinite(maxSeamPixels) || maxSeamPixels < 0 || maxSeamPixels > 100) throw new Error("Tolerância da emenda inválida.");
  if (seamErrorPixels > maxSeamPixels) throw new Error("O trecho corrigido não encaixa no tracking anterior sem salto. Amplie o In/Out ou rastreie o clipe inteiro com o mesmo detalhe.");
  const range = { startFrame: Math.min(oldRange.startFrame, freshRange.startFrame), endFrame: Math.max(oldRange.endFrame, freshRange.endFrame) };
  const samples = previous.samples.filter(sample => sample.frame < freshRange.startFrame || sample.frame > freshRange.endFrame).map(sample => ({ ...sample })).concat(corrected).sort((a, b) => a.frame - b.frame);
  const missing = missingRanges(samples, range);
  return { ...replacement, referenceFrame: previous.referenceFrame, samples, range, missing, lost: !!missing.length, truncated: !!missing.length, alignment: { frame: anchor.frame, dx, dy, seamErrorPixels } };
}

function aspectRatio(value) {
  if (value === undefined || value === null || value === "") return 1;
  if (typeof value === "number") {
    if (Number.isFinite(value) && value > 0) return value;
    throw new Error("Proporção de pixels inválida.");
  }
  const text = String(value).trim().replace(/,/g, ".");
  if (/square|quadrad/i.test(text)) return 1;
  const pair = /^([0-9]+(?:\.[0-9]+)?)\s*[:/]\s*([0-9]+(?:\.[0-9]+)?)$/.exec(text);
  const n = pair ? Number(pair[1]) / Number(pair[2]) : Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Proporção de pixels não reconhecida: " + text);
  return n;
}

// A clipboard stores sequence-space motion, independent of the target bitmap's
// resolution. Targets with different starts/In-points receive their own times.
function transferFrames(result, source, target, smoothing = 0) {
  const offsets = trackingOffsets(result, smoothing);
  if (source.sequence !== target.sequence || source.frameTicks !== target.frameTicks) throw new Error("Selecione o destino na mesma sequência do vídeo importado.");
  const ticks = Number(source.frameTicks);
  const durationFrames = Math.ceil(target.duration * source.fps - 0.00001);
  const sourceStart = Number(source.startTicks);
  const targetStart = Number(target.startTicks);
  const targetEnd = Number(target.endTicks);
  const first = offsets[0].frame;
  const last = offsets[offsets.length - 1].frame;
  const overlaps = targetStart <= sourceStart + last * ticks && targetEnd > sourceStart + first * ticks;
  const output = [];
  for (const p of offsets) {
    const frame = overlaps ? Math.round((sourceStart - targetStart) / ticks) + p.frame : p.frame - first;
    if (frame >= 0 && frame < durationFrames) output.push({ frame, dx: p.dx, dy: p.dy });
  }
  if (output.length < 2) throw new Error("O destino precisa ter pelo menos dois frames dentro do intervalo do tracking.");
  // Preserve the destination's placement at its first tracked frame.
  const origin = output[0];
  return output.map(p => ({ frame: p.frame, dx: p.dx - origin.dx, dy: p.dy - origin.dy }));
}

if (typeof module !== "undefined") module.exports = { trackingOffsets, aspectRatio, transferFrames, trackingBounds, missingRanges, selectTrackingRange, mergeTracking };
