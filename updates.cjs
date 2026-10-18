"use strict";

// This module only checks a public release. It never downloads or installs assets.
const ENDPOINT = "https://api.github.com/repos/yleosamp/FastTracker/releases/latest";
const RELEASE_BASE = "https://github.com/yleosamp/FastTracker/releases/tag/";
const CACHE_FILE = "updates.json";
const DAY = 24 * 60 * 60 * 1000;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parseVersion(value) {
  if (typeof value !== "string" || value.length > 48 || value.trim() !== value || !VERSION.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function releaseURL(tag) {
  if (typeof tag !== "string") return null;
  return parseVersion(tag.charAt(0) === "v" ? tag.slice(1) : tag) ? RELEASE_BASE + tag : null;
}

function fromTag(tag) {
  const url = releaseURL(tag);
  return url ? { version: tag.charAt(0) === "v" ? tag.slice(1) : tag, tag, url } : null;
}

function validateRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.draft !== false || value.prerelease !== false) return null;
  return fromTag(value.tag_name);
}

function cachedRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const release = fromTag(value.tag);
  return release && value.version === release.version ? release : null;
}

function failed(code) {
  const error = new Error(code);
  error.updateCheckCode = code;
  return error;
}

class UpdateChecker {
  constructor(options) {
    if (!options || !parseVersion(options.version)) throw new Error("Invalid installed version");
    this.version = options.version;
    this.fetch = options.fetch;
    this.io = options.io;
    this.now = options.now || Date.now;
    // Keep host globals called as globals, not methods on the checker. Browser
    // and UXP implementations can reject a foreign receiver (Illegal invocation).
    this.setTimer = options.setTimeout || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout || (id => clearTimeout(id));
    this.AbortController = Object.prototype.hasOwnProperty.call(options, "AbortController") ? options.AbortController :
      (typeof AbortController === "function" ? AbortController : null);
    this.timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 5000;
    this._checkedAt = 0;
    this._release = null;
    this._initializing = null;
    this._inflight = null;
  }

  _time() {
    const value = this.now();
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  _snapshot(checked, error) {
    const available = !!this._release && compareVersions(this._release.version, this.version) === 1;
    return {
      available,
      release: available ? Object.assign({}, this._release) : null,
      checkedAt: this._checkedAt,
      checked: !!checked,
      error: error || null
    };
  }

  get state() { return this._snapshot(false, null); }

  init() {
    if (!this._initializing) this._initializing = this._load();
    return this._initializing;
  }

  async _load() {
    try {
      const raw = await this.io.readJSON(CACHE_FILE);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const stamp = raw.checkedAt;
        if (Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= this._time()) this._checkedAt = stamp;
        this._release = cachedRelease(raw.release);
      }
    } catch (_) { /* Missing or unreadable optional cache must not block the panel. */ }
    return this.state;
  }

  check(options) {
    if (this._inflight) return this._inflight;
    const force = !!(options && options.force);
    this._inflight = this._check(force).catch(() => this._snapshot(false, "network"));
    const pending = this._inflight;
    pending.then(() => { if (this._inflight === pending) this._inflight = null; });
    return pending;
  }

  async _check(force) {
    await this.init();
    const stamp = this._time();
    if (!force && this._checkedAt > 0 && stamp >= this._checkedAt && stamp - this._checkedAt < DAY) return this._snapshot(false, null);
    this._checkedAt = stamp;
    let error = null;
    try {
      this._release = await this._request();
    } catch (failure) {
      error = failure && failure.updateCheckCode || "network";
    }
    try {
      await this.io.writeJSON(CACHE_FILE, {
        checkedAt: this._checkedAt,
        release: this._release ? Object.assign({}, this._release) : null
      });
    } catch (_) { /* In-memory backoff still works when optional cache writing fails. */ }
    return this._snapshot(true, error);
  }

  async _request() {
    if (typeof this.fetch !== "function") throw failed("network");
    let controller = null, timer = null;
    try { if (typeof this.AbortController === "function") controller = new this.AbortController(); } catch (_) {}
    const timeout = new Promise((_, reject) => {
      timer = this.setTimer(() => {
        reject(failed("timeout"));
        try { if (controller) controller.abort(); } catch (_) {}
      }, this.timeoutMs);
    });
    const request = (async () => {
      const options = { method: "GET", credentials: "omit", headers: { Accept: "application/vnd.github+json" } };
      if (controller) options.signal = controller.signal;
      const response = await this.fetch(ENDPOINT, options);
      // GitHub returns 404 when this public repository has no published release.
      if (response && response.status === 404) return null;
      if (!response || response.ok !== true) throw failed("http");
      let body;
      try { body = await response.json(); } catch (_) { throw failed("invalid"); }
      const release = validateRelease(body);
      if (!release) throw failed("invalid");
      return release;
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      if (timer !== null) this.clearTimer(timer);
    }
  }
}

module.exports = { ENDPOINT, DAY, parseVersion, compareVersions, releaseURL, validateRelease, UpdateChecker };
