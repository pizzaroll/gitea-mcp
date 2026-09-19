import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '../build/file-transfer/core.js';
import { FileChangeService } from '../build/file-transfer/service.js';
import { ChangeStore } from '../build/file-transfer/store.js';
import { environment, sourceInput, splicePatch } from './helpers.mjs';

test('123 KB actual HTTP download -> small upload -> review -> explicit commit -> exact-SHA re-export', async t => {
  const before = Buffer.from('// unchanged line\r\n'.repeat(6500) + 'process(frame);\r\n');
  const after = Buffer.from(before.toString().replace('process(frame);', 'dispatch_bounded(frame);'));
  const env = await environment(t, before);
  const { snapshot, patch, change } = await env.prepare(after);
  assert.ok(before.length > 123000); assert.ok(patch.length < 1000);
  const downloaded = await env.fetchFile(snapshot.file);
  assert.equal(downloaded.response.status, 200); assert.deepEqual(downloaded.bytes, before);
  assert.equal(downloaded.response.headers.get('cache-control'), 'no-store');
  assert.equal(downloaded.response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(env.repo.writes, 0); assert.equal(change.status, 'staged');
  const review = await env.service.get(change.change_id);
  assert.equal(review.review_sha256, change.review_sha256);
  assert.deepEqual((await env.fetchFile(review.before_file)).bytes, before);
  assert.deepEqual((await env.fetchFile(review.after_file)).bytes, after);
  assert.equal(env.repo.writes, 0);
  const receipt = await env.service.commit(change.change_id, review.review_sha256);
  assert.equal(receipt.status, 'published'); assert.equal(receipt.result_sha256, sha256(after));
  assert.equal(env.repo.writes, 1); assert.equal(env.repo.message, review.publication_message);
  const exported = await env.service.exportSource({ ...sourceInput, ref: receipt.commit_sha });
  assert.equal(exported.resolved_commit_sha, receipt.commit_sha);
  assert.equal(sha256((await env.fetchFile(exported.file)).bytes), sha256(after));
  assert.equal((await env.service.get(change.change_id)).commit_sha, receipt.commit_sha);
  t.diagnostic(JSON.stringify({ source_bytes: before.length, patch_bytes: patch.length, final_sha256: sha256(after) }));
});
for (const [name, overrides, code] of [
  ['source', { expected_source_sha256: '0'.repeat(64) }, 'SOURCE_HASH_MISMATCH'],
  ['upload', { upload_sha256: '0'.repeat(64) }, 'UPLOAD_HASH_MISMATCH'],
  ['result', { result_sha256: '0'.repeat(64) }, 'RESULT_HASH_MISMATCH'],
]) test(`prepare rejects ${name} hash mismatch without a write`, async t => {
  const env = await environment(t);
  await assert.rejects(env.prepare(Buffer.from('edited\r\n'), overrides), { code }); assert.equal(env.repo.writes, 0);
});
test('replacement supports binary and zero-length final bytes', async t => {
  const env = await environment(t);
  const { change } = await env.prepare(Buffer.alloc(0), { mode: 'replace', file: { bytes: Buffer.alloc(0) }, upload_sha256: sha256('') });
  assert.equal(change.result_sha256, sha256('')); assert.equal(env.repo.writes, 0);
});
test('review mismatch and stale branch (even unrelated movement) block publication', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  await assert.rejects(env.service.commit(change.change_id, '0'.repeat(64)), { code: 'REVIEW_MISMATCH' });
  env.repo.move();
  await assert.rejects(env.service.commit(change.change_id, change.review_sha256), error => {
    assert.equal(error.code, 'STALE_BRANCH'); assert.equal(error.details.expected_commit_sha, change.base_commit_sha);
    assert.equal(error.details.observed_commit_sha, env.repo.current); return true;
  });
  assert.equal(env.repo.writes, 0);
});
test('concurrent commits of the same staged change publish once', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  const receipts = await Promise.all(Array.from({ length: 8 }, () => env.service.commit(change.change_id, change.review_sha256)));
  assert.equal(env.repo.writes, 1); assert.ok(receipts.every(r => r.commit_sha === receipts[0].commit_sha && r.status === 'published'));
});
test('unknown write outcome is durable and never retried', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  env.repo.failWrite = true;
  const result = await env.service.commit(change.change_id, change.review_sha256);
  assert.equal(result.status, 'publication_unknown'); assert.equal(env.repo.writes, 1);
  env.store.close(); const reopened = new ChangeStore(env.dir);
  const service = new FileChangeService(reopened, () => env.repo, env.artifacts, async () => Buffer.alloc(0));
  assert.equal((await service.commit(change.change_id, change.review_sha256)).status, 'publication_unknown');
  assert.equal(env.repo.writes, 1); reopened.close();
});
test('durable publishing intent after crash cannot issue a PUT', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  const record = env.store.get(change.change_id); record.status = 'publishing'; env.store.put(record);
  assert.equal((await env.service.commit(change.change_id, change.review_sha256)).status, 'publishing');
  assert.equal(env.repo.writes, 0);
});
test('race after HEAD preflight is reported, not hidden as CAS success', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  env.repo.beforeUpdate = () => env.repo.move();
  const result = await env.service.commit(change.change_id, change.review_sha256);
  assert.equal(result.status, 'published_branch_race'); assert.ok(result.commit_sha);
  assert.notEqual(result.observed_parents[0], result.base_commit_sha);
});
test('concurrent file edit after preflight is not overwritten', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  env.repo.beforeUpdate = () => env.repo.move(Buffer.from('someone else'));
  const result = await env.service.commit(change.change_id, change.review_sha256);
  assert.equal(result.status, 'publication_unknown'); assert.equal(result.publication_error, 'GITEA_CONFLICT');
  assert.equal((await env.repo.read({}, env.repo.current)).bytes.toString(), 'someone else');
});
test('corrupt staged bytes block publication; changed credentials block review', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited'));
  const filename = `${env.dir}/${change.change_id}.json`, record = JSON.parse(readFileSync(filename));
  record.after_base64 = Buffer.from('tampered').toString('base64'); writeFileSync(filename, JSON.stringify(record));
  await assert.rejects(env.service.commit(change.change_id, change.review_sha256), { code: 'STATE_CORRUPT' });
  assert.equal(env.repo.writes, 0); env.repo.principal = 'different-principal';
  await assert.rejects(env.service.get(change.change_id), { code: 'STATE_PRINCIPAL_CHANGED' });
});
test('upstream revoked read permission prevents review downloads', async t => {
  const env = await environment(t), { change } = await env.prepare(Buffer.from('edited')); env.repo.forbidden = true;
  await assert.rejects(env.service.get(change.change_id), { code: 'GITEA_FORBIDDEN' });
});
test('capability endpoint never serves arbitrary paths or unsupported methods', async t => {
  const env = await environment(t); const root = `http://127.0.0.1:${env.port}`;
  for (const path of ['/etc/passwd', '/file-transfer/..%2fsecret', '/file-transfer/' + '0'.repeat(64)]) {
    assert.equal((await fetch(root + path)).status, 404);
  }
  assert.equal((await fetch(root + '/file-transfer/x', { method: 'POST' })).status, 405);
});
