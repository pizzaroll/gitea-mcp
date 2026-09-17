import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, statSync, chmodSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactServer } from '../build/file-transfer/transfer.js';
import { ChangeStore, newID } from '../build/file-transfer/store.js';
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true })); return dir;
}
test('private durable records, lock exclusion and traversal protection', t => {
  const dir = directory(t), store = new ChangeStore(dir), id = newID();
  try {
    store.put({ id, kind: 'test', expires_at: Date.now() + 10000, value: 'data' });
    assert.equal(statSync(`${dir}/${id}.json`).mode & 0o777, 0o600);
    assert.equal(store.get(id).value, 'data'); assert.throws(() => new ChangeStore(dir), /locked/);
    assert.throws(() => store.get('../x'));
  } finally { store.close(); }
  const second = new ChangeStore(dir); assert.equal(second.get(id).value, 'data'); second.close();
});
test('unsafe state directory permissions and symlink roots are rejected', t => {
  const dir = directory(t); chmodSync(dir, 0o755); assert.throws(() => new ChangeStore(dir), { code: 'UNSAFE_STATE_DIRECTORY' });
  chmodSync(dir, 0o700); const link = `${dir}/link`; symlinkSync(dir, link);
  assert.throws(() => new ChangeStore(link), { code: 'UNSAFE_STATE_DIRECTORY' });
});
test('symlink state records are never read', t => {
  const dir = directory(t), store = new ChangeStore(dir), id = newID();
  try {
    writeFileSync(`${dir}/outside`, 'not a record', { mode: 0o600 }); symlinkSync(`${dir}/outside`, `${dir}/${id}.json`);
    assert.throws(() => store.get(id));
  } finally { store.close(); }
});
test('expired records are collected and byte/record quotas are enforced', t => {
  let now = 100;
  const dir = directory(t), store = new ChangeStore(dir, 1000, 1, () => now);
  try {
    const id = newID(); store.put({ id, kind: 'test', expires_at: 150 });
    assert.throws(() => store.put({ id: newID(), kind: 'test', expires_at: 200 }), { code: 'STATE_QUOTA_EXCEEDED' });
    now = 151; assert.throws(() => store.get(id), { code: 'EXPIRED' });
    store.put({ id: newID(), kind: 'test', expires_at: 200 });
    assert.equal(readdirSync(dir).filter(n => n.endsWith('.json')).length, 1);
    assert.throws(() => store.put({ id: newID(), kind: 'test', expires_at: 200, data: 'x'.repeat(2000) }), { code: 'STATE_QUOTA_EXCEEDED' });
  } finally { store.close(); }
});
test('HTTPS capabilities expire and HEAD does not consume the file', async t => {
  let now = 1000; const artifacts = new ArtifactServer('https://example.test/files', () => now);
  const port = await artifacts.listen(0, '127.0.0.1'); t.after(() => artifacts.close());
  const file = artifacts.add(Buffer.from('secret source'), '../../source.ts');
  const url = `http://127.0.0.1:${port}${new URL(file.download_url).pathname}`;
  const head = await fetch(url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.equal(await (await fetch(url)).text(), 'secret source');
  assert.equal((await fetch(url + '?extra=1')).status, 404);
  now += 300001; assert.equal((await fetch(url)).status, 404);
});
