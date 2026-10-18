const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../updates.cjs');

const STAMP = 1792238400000;
const release = (tag = 'v0.3.3', extra = {}) => Object.assign({ tag_name: tag, draft: false, prerelease: false }, extra);
const response = body => ({ ok: true, status: 200, json: async () => body });
const pending = () => new Promise(() => {});

function fixture(options = {}) {
  const writes = [], requests = [];
  let stamp = options.stamp === undefined ? STAMP : options.stamp;
  const io = {
    async readJSON(name) { assert.equal(name, 'updates.json'); if (options.cacheError) throw Error('cache'); return options.cache; },
    async writeJSON(name, data) { assert.equal(name, 'updates.json'); if (options.writeError) throw Error('read only'); writes.push(JSON.parse(JSON.stringify(data))); }
  };
  const fetch = async (...args) => { requests.push(args); return options.fetch ? options.fetch(...args) : response(release()); };
  const checker = new U.UpdateChecker(Object.assign({ version: options.version || '0.3.2', io, fetch, now: () => stamp }, options.checker));
  return { checker, writes, requests, tick(ms) { stamp += ms; } };
}

test('strict stable versions compare numerically without prereleases or unsafe integers', () => {
  assert.equal(U.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(U.compareVersions('1.0.0', '0.99.999'), 1);
  assert.equal(U.compareVersions('0.3.2', '0.3.2'), 0);
  assert.equal(U.compareVersions('0.3.1', '0.3.2'), -1);
  for (const value of ['', ' 1.2.3', 'v1.2.3', '01.2.3', '1.2', '1.2.3-beta', '1.2.3+build', '9007199254740992.0.0', null, 123]) {
    assert.equal(U.parseVersion(value), null, String(value));
  }
  assert.equal(U.compareVersions('invalid', '1.2.3'), null);
});

test('release URL is derived only from a strict safe version tag, never API links', () => {
  assert.equal(U.releaseURL('v1.2.3'), 'https://github.com/yleosamp/FastTracker/releases/tag/v1.2.3');
  assert.equal(U.releaseURL('1.2.3'), 'https://github.com/yleosamp/FastTracker/releases/tag/1.2.3');
  for (const tag of ['v1.2.3/evil', 'https://evil.test', 'v1.2.3?x=1', 'V1.2.3', 'v1.2.3#x', '../v1.2.3', 'v1.2.3\n', '1.2.3%2Fbad']) assert.equal(U.releaseURL(tag), null);
  const actual = U.validateRelease(release('v1.2.3', { html_url: 'https://evil.test', name: '<script>', body: 'private-looking text', assets: [{ browser_download_url: 'https://evil.test' }] }));
  assert.deepEqual(actual, { version: '1.2.3', tag: 'v1.2.3', url: U.releaseURL('v1.2.3') });
  for (const body of [null, [], {}, release('v1.2.3-beta'), release('v1.2.3', { draft: true }), release('v1.2.3', { prerelease: true }), { tag_name: 'v1.2.3' }]) assert.equal(U.validateRelease(body), null);
});

test('initializing is local-only and a newer public release is saved as minimal anonymous cache', async () => {
  const f = fixture();
  assert.equal((await f.checker.init()).available, false);
  assert.equal(f.requests.length, 0);
  const state = await f.checker.check();
  assert.equal(state.available, true); assert.equal(state.checked, true); assert.equal(state.error, null);
  assert.equal(state.release.version, '0.3.3'); assert.equal(state.checkedAt, STAMP);
  assert.equal(f.requests[0][0], U.ENDPOINT);
  assert.deepEqual(Object.keys(f.requests[0][1]).sort(), ['credentials', 'headers', 'method', 'signal']);
  assert.equal(f.requests[0][1].credentials, 'omit');
  assert.deepEqual(f.requests[0][1].headers, { Accept: 'application/vnd.github+json' });
  assert.deepEqual(f.writes, [{ checkedAt: STAMP, release: { version: '0.3.3', tag: 'v0.3.3', url: U.releaseURL('v0.3.3') } }]);
  state.release.tag = 'https://evil.test';
  assert.equal(f.checker.state.release.tag, 'v0.3.3');
});

test('equal and older releases never show an update, including after installed-version changes', async () => {
  for (const tag of ['v0.3.2', 'v0.3.1']) {
    const f = fixture({ fetch: async () => response(release(tag)) });
    assert.equal((await f.checker.check()).available, false); assert.equal(f.checker.state.release, null);
  }
  const cache = { checkedAt: STAMP - 1, release: { version: '0.3.3', tag: 'v0.3.3', url: 'https://evil.test' } };
  const upgraded = fixture({ cache, version: '0.4.0' });
  assert.equal((await upgraded.checker.init()).available, false);
  const rolledBack = fixture({ cache, version: '0.3.0' });
  const state = await rolledBack.checker.init();
  assert.equal(state.available, true); assert.equal(state.release.url, U.releaseURL('v0.3.3'));
});

test('automatic checks are throttled for 24 hours across reloads; force bypasses backoff', async () => {
  const f = fixture();
  await f.checker.check();
  assert.equal((await f.checker.check()).checked, false); assert.equal(f.requests.length, 1);
  f.tick(U.DAY - 1); assert.equal((await f.checker.check()).checked, false);
  f.tick(1); assert.equal((await f.checker.check()).checked, true); assert.equal(f.requests.length, 2);
  assert.equal((await f.checker.check({ force: true })).checked, true); assert.equal(f.requests.length, 3);
  const restored = fixture({ cache: f.writes[0] });
  assert.equal((await restored.checker.check()).available, true); assert.equal(restored.requests.length, 0);
});

test('concurrent manual and automatic checks share one in-flight request', async () => {
  let resolve;
  const f = fixture({ fetch: () => new Promise(done => { resolve = done; }) });
  const first = f.checker.check(), second = f.checker.check({ force: true });
  assert.equal(first, second);
  await new Promise(done => setImmediate(done));
  assert.equal(f.requests.length, 1);
  resolve(response(release()));
  assert.equal((await first).available, true);
  const third = f.checker.check({ force: true });
  await new Promise(done => setImmediate(done));
  resolve(response(release())); await third;
});

test('offline and HTTP failures are non-throwing, keep validated cache, and also back off', async () => {
  const cache = { checkedAt: STAMP - U.DAY, release: { version: '0.3.3', tag: 'v0.3.3', url: U.releaseURL('v0.3.3') } };
  for (const [failure, code] of [[() => { throw Error('offline'); }, 'network'], [() => ({ ok: false, status: 403 }), 'http'], [() => ({ ok: false, status: 500 }), 'http']]) {
    const f = fixture({ cache, fetch: failure });
    const state = await f.checker.check();
    assert.equal(state.available, true); assert.equal(state.error, code); assert.equal(state.checked, true);
    assert.equal((await f.checker.check()).checked, false); assert.equal(f.requests.length, 1);
    assert.equal(f.writes[0].release.version, '0.3.3');
  }
});

test('404 means no published release and removes a previously cached notice', async () => {
  const f = fixture({ cache: { checkedAt: STAMP - U.DAY, release: { version: '0.3.3', tag: 'v0.3.3' } }, fetch: () => ({ ok: false, status: 404 }) });
  const state = await f.checker.check();
  assert.equal(state.error, null); assert.equal(state.available, false); assert.equal(f.writes[0].release, null);
});

test('malformed responses, drafts, prereleases and malformed JSON never become notices', async () => {
  for (const value of [{}, null, [], release('v2.0.0', { draft: true }), release('v2.0.0', { prerelease: true }), release('v2.0.0-beta')]) {
    const f = fixture({ fetch: () => response(value) });
    const state = await f.checker.check();
    assert.equal(state.error, 'invalid'); assert.equal(state.available, false);
  }
  const f = fixture({ fetch: () => ({ ok: true, json: () => { throw Error('JSON'); } }) });
  assert.equal((await f.checker.check()).error, 'invalid');
});

test('invalid cache is ignored; future timestamps and a rolled-back clock cannot suppress checks forever', async () => {
  for (const cache of [null, [], 'bad', { checkedAt: 'tomorrow', release: {} }, { checkedAt: STAMP + U.DAY, release: { tag: 'v99.0.0', version: 'other' } }]) {
    const f = fixture({ cache });
    const state = await f.checker.init(); assert.equal(state.available, false); assert.equal(state.checkedAt, 0);
    await f.checker.check(); assert.equal(f.requests.length, 1);
  }
  const f = fixture();
  await f.checker.check(); f.tick(-1000); await f.checker.check();
  assert.equal(f.requests.length, 2);
});

test('optional cache read/write failure does not prevent checks or the available badge', async () => {
  const f = fixture({ cacheError: true, writeError: true });
  const state = await f.checker.check();
  assert.equal(state.available, true); assert.equal(state.error, null);
  await f.checker.check(); assert.equal(f.requests.length, 1);
});

test('a never-resolving fetch times out, aborts when supported, clears its timer, and can retry', async () => {
  let aborts = 0, clears = 0, scheduled;
  class Controller { constructor() { this.signal = {}; } abort() { aborts++; } }
  const f = fixture({ fetch: pending, checker: { AbortController: Controller, setTimeout(fn) { scheduled = fn; return 42; }, clearTimeout(id) { assert.equal(id, 42); clears++; } } });
  const attempt = f.checker.check();
  await new Promise(done => setImmediate(done));
  scheduled(); const state = await attempt;
  assert.equal(state.error, 'timeout'); assert.equal(aborts, 1); assert.equal(clears, 1);
  assert.equal((await f.checker.check()).checked, false);
  const retry = f.checker.check({ force: true });
  await new Promise(done => setImmediate(done)); scheduled();
  assert.equal((await retry).error, 'timeout'); assert.equal(f.requests.length, 2); assert.equal(clears, 2);
});

test('timeout also covers response JSON and works when AbortController is unavailable', async () => {
  let scheduled, clears = 0;
  const f = fixture({ fetch: () => ({ ok: true, json: pending }), checker: { AbortController: null, setTimeout(fn) { scheduled = fn; return 0; }, clearTimeout(id) { assert.equal(id, 0); clears++; } } });
  const attempt = f.checker.check();
  await new Promise(done => setImmediate(done)); scheduled();
  assert.equal((await attempt).error, 'timeout'); assert.equal(clears, 1);
  assert.equal('signal' in f.requests[0][1], false);
});

test('completed and failed requests clear timers and leave no repeating scheduler', async () => {
  for (const fetch of [() => response(release()), () => { throw Error('offline'); }]) {
    let scheduled = 0, cleared = 0;
    const f = fixture({ fetch, checker: { setTimeout() { scheduled++; return 9; }, clearTimeout(id) { assert.equal(id, 9); cleared++; } } });
    await f.checker.check();
    assert.equal(scheduled, 1); assert.equal(cleared, 1);
    await f.checker.check(); assert.equal(scheduled, 1);
  }
});

test('host timer globals never receive the checker as their receiver', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  let clears = 0;
  const context = { module: { exports: {} },
    setTimeout(fn, ms) { if (this && this._request) throw new Error('Illegal invocation'); return setTimeout(fn, ms); },
    clearTimeout(id) { if (this && this._request) throw new Error('Illegal invocation'); clears++; clearTimeout(id); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../updates.cjs'), 'utf8'), context);
  const checker = new context.module.exports.UpdateChecker({ version: '0.3.2',
    fetch: async () => response(release()), io: { async readJSON() { return null; }, async writeJSON() {} } });
  assert.equal((await checker.check()).available, true); assert.equal(clears, 1);
});
