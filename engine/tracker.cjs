"use strict";

// A region of feature points follows a user-selected point. Median translation
// and forward/backward checks reject mismatches before they accumulate as drift.
function median(values) {
  const copy = values.slice().sort((a, b) => a - b);
  return copy.length % 2 ? copy[(copy.length - 1) / 2] : (copy[copy.length / 2 - 1] + copy[copy.length / 2]) / 2;
}

function copyMat(cv, source) {
  // Embind's .clone() duplicates the JS handle in this build, sharing pixels.
  // copyTo() is required to retain a genuinely independent previous frame.
  const copy = new cv.Mat();
  source.copyTo(copy);
  return copy;
}

class PointTracker {
  constructor(cv, width, height, point, radius = 32, options = {}) {
    this.cv = cv;
    this.width = width;
    this.height = height;
    this.point = { x: point.x, y: point.y };
    this.radius = radius;
    this.confidenceThreshold = options.confidenceThreshold === undefined ? 0.55 : options.confidenceThreshold;
    if (!Number.isFinite(this.confidenceThreshold) || this.confidenceThreshold < 0.1 || this.confidenceThreshold > 0.95) throw new Error("Limite de confiança inválido.");
    this.previous = null;
    this.points = null;
    this.template = null;
    this.templateRadius = Math.max(9, Math.min(22, Math.round(radius * 0.5)));
  }

  features(gray) {
    const cv = this.cv;
    const mask = cv.Mat.zeros(this.height, this.width, cv.CV_8UC1);
    const corners = new cv.Mat();
    try {
      cv.rectangle(mask,
        new cv.Point(Math.max(0, Math.round(this.point.x - this.radius)), Math.max(0, Math.round(this.point.y - this.radius))),
        new cv.Point(Math.min(this.width - 1, Math.round(this.point.x + this.radius)), Math.min(this.height - 1, Math.round(this.point.y + this.radius))),
        new cv.Scalar(255), -1);
      cv.goodFeaturesToTrack(gray, corners, 60, 0.012, 4, mask, 5, false, 0.04);
      return corners;
    } catch (error) {
      corners.delete();
      throw error;
    } finally { mask.delete(); }
  }

  patch(gray, point) {
    const r = this.templateRadius;
    const x = Math.round(point.x) - r;
    const y = Math.round(point.y) - r;
    if (x < 0 || y < 0 || x + 2 * r + 1 > this.width || y + 2 * r + 1 > this.height) return null;
    const roi = gray.roi(new this.cv.Rect(x, y, 2 * r + 1, 2 * r + 1));
    try { return copyMat(this.cv, roi); } finally { roi.delete(); }
  }

  start(gray) {
    this.points = this.features(gray);
    this.template = this.patch(gray, this.point);
    if (this.points.rows < 4 || !this.template) {
      this.dispose();
      throw new Error("Escolha uma região com mais detalhe/contraste e longe da borda.");
    }
    this.previous = copyMat(this.cv, gray);
    return { x: this.point.x, y: this.point.y, confidence: 1, features: this.points.rows };
  }

  match(gray) {
    if (!this.template) return null;
    const cv = this.cv;
    const reach = Math.round(this.radius * 1.7);
    const r = this.templateRadius;
    const x = Math.max(0, Math.round(this.point.x - reach - r));
    const y = Math.max(0, Math.round(this.point.y - reach - r));
    const w = Math.min(this.width - x, 2 * (reach + r) + 1);
    const h = Math.min(this.height - y, 2 * (reach + r) + 1);
    if (w < this.template.cols || h < this.template.rows) return null;
    const roi = gray.roi(new cv.Rect(x, y, w, h));
    const result = new cv.Mat();
    try {
      cv.matchTemplate(roi, this.template, result, cv.TM_CCOEFF_NORMED);
      const best = cv.minMaxLoc(result);
      if (!Number.isFinite(best.maxVal) || best.maxVal < Math.max(0.5, Math.min(0.98, this.confidenceThreshold + 0.27))) return null;
      return { x: x + best.maxLoc.x + r, y: y + best.maxLoc.y + r, confidence: best.maxVal };
    } finally { roi.delete(); result.delete(); }
  }

  step(gray) {
    const cv = this.cv;
    const next = new cv.Mat();
    const status = new cv.Mat();
    const error = new cv.Mat();
    const back = new cv.Mat();
    const backStatus = new cv.Mat();
    const backError = new cv.Mat();
    let candidate = null;
    try {
      const criteria = new cv.TermCriteria(cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 25, 0.01);
      cv.calcOpticalFlowPyrLK(this.previous, gray, this.points, next, status, error, new cv.Size(21, 21), 3, criteria);
      cv.calcOpticalFlowPyrLK(gray, this.previous, next, back, backStatus, backError, new cv.Size(21, 21), 3, criteria);
      const dx = [], dy = [];
      for (let i = 0; i < this.points.rows; i += 1) {
        const j = i * 2;
        const distance = Math.hypot(this.points.data32F[j] - back.data32F[j], this.points.data32F[j + 1] - back.data32F[j + 1]);
        if (status.data[i] && backStatus.data[i] && distance < 1.5 && error.data32F[i] < 35) {
          dx.push(next.data32F[j] - this.points.data32F[j]);
          dy.push(next.data32F[j + 1] - this.points.data32F[j + 1]);
        }
      }
      if (dx.length >= 4) {
        const mx = median(dx), my = median(dy);
        const deviations = dx.map((x, i) => Math.hypot(x - mx, dy[i] - my));
        const inliers = deviations.filter(d => d < Math.max(2, median(deviations) * 2.5)).length;
        const confidence = Math.min(1, dx.length / Math.max(8, this.points.rows * 0.65)) * inliers / dx.length;
        if (confidence >= this.confidenceThreshold && Math.hypot(mx, my) < this.radius * 1.7) {
          candidate = { x: this.point.x + mx, y: this.point.y + my, confidence };
        }
      }
      if (!candidate) candidate = this.match(gray);
      if (!candidate || candidate.x < this.templateRadius || candidate.y < this.templateRadius || candidate.x >= this.width - this.templateRadius || candidate.y >= this.height - this.templateRadius) {
        return { lost: true, x: this.point.x, y: this.point.y, confidence: 0 };
      }
      // Match against the initial template as a drift check when appearance is stable.
      const templateMatch = this.match(gray);
      if (templateMatch && Math.hypot(templateMatch.x - candidate.x, templateMatch.y - candidate.y) < 3) {
        candidate.x = candidate.x * 0.65 + templateMatch.x * 0.35;
        candidate.y = candidate.y * 0.65 + templateMatch.y * 0.35;
      }
      // features() searches around this.point. Use the candidate only while
      // finding corners; a rejected refresh must retain the old point AND
      // its matching previous-frame/corner data for the next optical-flow step.
      const retainedPoint = this.point;
      let refreshed;
      try {
        this.point = { x: candidate.x, y: candidate.y };
        refreshed = this.features(gray);
      } finally { this.point = retainedPoint; }
      if (refreshed.rows < 4) { refreshed.delete(); return { lost: true, ...candidate }; }
      let previous;
      try { previous = copyMat(this.cv, gray); }
      catch (error) { refreshed.delete(); throw error; }
      this.points.delete();
      this.points = refreshed;
      this.previous.delete();
      this.previous = previous;
      this.point = { x: candidate.x, y: candidate.y };
      return { ...candidate, features: this.points.rows, lost: false };
    } finally {
      next.delete(); status.delete(); error.delete(); back.delete(); backStatus.delete(); backError.delete();
    }
  }

  dispose() {
    for (const key of ["previous", "points", "template"]) {
      if (this[key]) { this[key].delete(); this[key] = null; }
    }
  }
}

module.exports = { PointTracker, median };
