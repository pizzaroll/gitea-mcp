// Runs only against a disposable Gitea created by CI; never uses a user's instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRepository } from '../../build/file-transfer/repository.js';
import { FileChangeService } from '../../build/file-transfer/service.js';
import { ChangeStore } from '../../build/file-transfer/store.js';
import { ArtifactServer } from '../../build/file-transfer/transfer.js';
import { sha256 } from '../../build/file-transfer/core.js';
import { splicePatch } from '../helpers.mjs';

test('disposable Gitea: immutable export, stage/review, publish, exact-SHA hash verification and stale rejection', async () => {
  const url = process.env.GITEA_TEST_URL;
  assert.equal(url, 'http://127.0.0.1:3000', 'This test is restricted to the disposable local CI Gitea');
  async function api(path, body, auth, method = 'POST') {
    const response = await fetch(url + '/api/v1' + path, { method, headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `Gitea HTTP ${response.status} for ${path}`); return response.json();
  }
  const { sha1: token } = await api('/users/mcp-test/tokens', { name: 'ci-file-transfer', scopes: ['all'] },
    'Basic ' + Buffer.from('mcp-test:Integration-only-123!').toString('base64'));
  const auth = `token ${token}`;
  await api('/user/repos', { name: 'file-transfer-ci', auto_init: true, default_branch: 'work' }, auth);
  const before = Buffer.from('// unchanged line\r\n'.repeat(6500) + 'process(frame);\r\n');
  const after = Buffer.from(before.toString().replace('process(frame);', 'dispatch_bounded(frame);'));
  await api('/repos/mcp-test/file-transfer-ci/contents/src/large.ts', { content: before.toString('base64'), message: 'CI fixture', branch: 'work' }, auth);
  const directory = mkdtempSync(join(tmpdir(), 'gitea-live-')), store = new ChangeStore(directory);
  const artifacts = new ArtifactServer('https://ci.example.test/file-transfer');
  const port = await artifacts.listen(0, '127.0.0.1');
  const repo = new FileRepository({ baseUrl: url, token, timeout: 10000, rateLimit: { requests: 1000, windowMs: 60000 } }, 'ci-principal');
  const service = new FileChangeService(store, () => repo, artifacts, async f => f.bytes);
  const input = { instanceId: 'test', owner: 'mcp-test', repository: 'file-transfer-ci', path: 'src/large.ts', ref: 'work' };
  try {
    const exported = await service.exportSource(input), patch = splicePatch(before, after);
    const downloaded = await fetch(`http://127.0.0.1:${port}${new URL(exported.file.download_url).pathname}`);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), before);
    assert.ok(patch.length < 1000);
    const change = await service.prepare({ snapshot_id: exported.snapshot_id, file: { bytes: patch }, mode: 'byte_patch',
      expected_source_sha256: sha256(before), upload_sha256: sha256(patch), result_sha256: sha256(after), message: 'Exact-byte change' });
    assert.equal(await repo.head(input.owner, input.repository, 'work'), exported.base_commit_sha);
    const review = await service.get(change.change_id);
    assert.equal(review.status, 'staged');
    const receipt = await service.commit(change.change_id, review.review_sha256);
    assert.equal(receipt.status, 'published', JSON.stringify(receipt));
    assert.equal((await service.commit(change.change_id, review.review_sha256)).commit_sha, receipt.commit_sha);
    const final = await service.exportSource({ ...input, ref: receipt.commit_sha });
    assert.equal(final.source_sha256, sha256(after)); assert.equal(final.resolved_commit_sha, receipt.commit_sha);
    const staleSnapshot = await service.exportSource(input);
    const newer = Buffer.concat([after, Buffer.from('// next\r\n')]), nextPatch = splicePatch(after, newer);
    const staged = await service.prepare({ snapshot_id: staleSnapshot.snapshot_id, file: { bytes: nextPatch }, mode: 'byte_patch',
      expected_source_sha256: sha256(after), upload_sha256: sha256(nextPatch), result_sha256: sha256(newer), message: 'Must reject stale HEAD' });
    await api('/repos/mcp-test/file-transfer-ci/contents/unrelated.txt', { content: Buffer.from('concurrent work').toString('base64'), message: 'Concurrent work', branch: 'work' }, auth);
    await assert.rejects(service.commit(staged.change_id, staged.review_sha256), { code: 'STALE_BRANCH' });
    assert.equal(sha256((await repo.read(input, receipt.commit_sha)).bytes), sha256(after));
    console.log(JSON.stringify({ gitea_commit_sha: receipt.commit_sha, source_bytes: before.length, patch_bytes: patch.length, result_sha256: final.source_sha256 }));
  } finally { await artifacts.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
