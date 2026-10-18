const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const U = require('../updates.cjs');
async function panel(tag = 'v0.4.5', offline = false) {
  const nodes = { 'update-available': { hidden: true }, 'check-updates': {} };
  const opens = [], requests = [], writes = [];
  const document = { hidden: false, getElementById: id => nodes[id], addEventListener() {} };
  const window = { fetch: async (url, options) => { requests.push({ url, options }); if (offline) throw Error('offline'); return { ok: true, status: 200, json: async () => ({ draft: false, prerelease: false, tag_name: tag }) }; },
    cep: { util: { openURLInDefaultBrowser: url => opens.push(url) } }, cep_node: { require(name) {
      if (name === 'path') return path;
      if (name === 'os') return { tmpdir: () => 'C:/memory-only' };
      if (name === 'fs') return { readFileSync(file) { if (file.endsWith('package.json')) return JSON.stringify({ version: '0.4.4' }); throw Error('no cache'); }, writeFileSync(file, text) { writes.push({ file, data: JSON.parse(text) }); } };
      if (name.endsWith('updates.cjs')) return U;
      throw Error('unexpected module');
    } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../updates-ui.js'), 'utf8'), { window, document, location: { pathname: '/C:/fixture/index.html' } });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  await settle();
  return { nodes, opens, requests, writes, settle };
}
test('new release shows a discreet notice; external page opens only on explicit click', async () => {
  const p = await panel();
  assert.equal(p.nodes['update-available'].hidden, false); assert.deepEqual(p.opens, []);
  p.nodes['update-available'].onclick();
  assert.deepEqual(p.opens, ['https://github.com/yleosamp/FastTracker/releases/tag/v0.4.5']);
  assert.equal(p.requests[0].options.credentials, 'omit');
  assert.deepEqual(Object.keys(p.writes[0].data).sort(), ['checkedAt', 'release']);
});
test('same version has no update notice and manual check bypasses cached backoff', async () => {
  const p = await panel('v0.4.4'); assert.equal(p.nodes['update-available'].hidden, true);
  p.nodes['check-updates'].onclick(); await p.settle(); assert.equal(p.requests.length, 2);
  p.nodes['update-available'].onclick(); assert.deepEqual(p.opens, []);
});
test('offline checking does not throw or leave manual check disabled', async () => {
  const p = await panel('v0.4.5', true);
  assert.equal(p.nodes['check-updates'].disabled, false); assert.equal(p.nodes['update-available'].hidden, true);
});
