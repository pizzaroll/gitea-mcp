import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FileRepository } from '../build/file-transfer/repository.js';
import { blob } from './helpers.mjs';
const commit = 'a'.repeat(40), rootTree = 'b'.repeat(40), subTree = 'c'.repeat(40), next = 'd'.repeat(40);
async function fixture(t, overrides = {}) {
  const bytes = Buffer.from('one\r\ntwo\x00'), blobSHA = blob(bytes), requests = [];
  const responses = {
    '/api/v1/repos/alice/sandbox/git/commits/work': { sha: commit, commit: { tree: { sha: rootTree } }, parents: [] },
    [`/api/v1/repos/alice/sandbox/git/commits/${commit}`]: { sha: commit, commit: { tree: { sha: rootTree } }, parents: [] },
    '/api/v1/repos/alice/sandbox/branches/work': { commit: { id: commit } },
    [`/api/v1/repos/alice/sandbox/git/trees/${rootTree}`]: { tree: [{ path: 'src', type: 'tree', mode: '040000', sha: subTree }], truncated: false },
    [`/api/v1/repos/alice/sandbox/git/trees/${subTree}`]: { tree: [{ path: 'file.ts', type: 'blob', mode: '100644', sha: blobSHA }], truncated: false },
    [`/api/v1/repos/alice/sandbox/git/blobs/${blobSHA}`]: { sha: blobSHA, content: bytes.toString('base64'), encoding: 'base64', size: bytes.length },
    '/api/v1/repos/alice/sandbox/contents/src/file.ts': { commit: { sha: next } },
    ...overrides,
  };
  const server = createServer(async (req, res) => {
    const body = []; for await (const b of req) body.push(b);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(body).toString() });
    const path = new URL(req.url, 'http://localhost').pathname, result = responses[path];
    if (!result) { res.writeHead(404); res.end('not found'); return; }
    if (result.redirect) { res.writeHead(302, { location: result.redirect }); res.end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const repo = new FileRepository({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    token: 'unit-test-secret', timeout: 5000, rateLimit: { requests: 100, windowMs: 60000 } }, 'test-principal');
  return { repo, bytes, blobSHA, requests, responses };
}
const target = { owner: 'alice', repository: 'sandbox', path: 'src/file.ts' };
test('Gitea adapter walks exact commit/tree/blob and sends guarded PUT with no force fields', async t => {
  const f = await fixture(t);
  assert.equal(await f.repo.resolve('alice', 'sandbox', 'work'), commit);
  assert.equal(await f.repo.head('alice', 'sandbox', 'work'), commit);
  assert.deepEqual((await f.repo.read(target, commit)).bytes, f.bytes);
  assert.equal(await f.repo.update(target, 'work', f.blobSHA, Buffer.from('changed'), 'message'), next);
  const write = f.requests.find(r => r.method === 'PUT');
  assert.deepEqual(JSON.parse(write.body), { branch: 'work', sha: f.blobSHA, content: Buffer.from('changed').toString('base64'), message: 'message' });
  assert.ok(f.requests.every(r => r.headers.authorization === 'token unit-test-secret'));
});
for (const [name, at, mode, type] of [['parent symlink', rootTree, '120000', 'blob'],
  ['file symlink', subTree, '120000', 'blob'], ['gitlink', subTree, '160000', 'commit']]) {
  test(`Gitea adapter rejects ${name}`, async t => {
    const f = await fixture(t); const entry = f.responses[`/api/v1/repos/alice/sandbox/git/trees/${at}`].tree[0];
    entry.mode = mode; entry.type = type;
    await assert.rejects(f.repo.read(target, commit), { code: 'NOT_REGULAR_FILE' });
    assert.ok(!f.requests.some(r => r.url.includes('/git/blobs/')));
  });
}
test('Gitea adapter rejects mismatched native blob bytes', async t => {
  const f = await fixture(t); f.responses[`/api/v1/repos/alice/sandbox/git/blobs/${f.blobSHA}`].content = Buffer.from('WRONG\r\nx').toString('base64');
  await assert.rejects(f.repo.read(target, commit), { code: 'GITEA_CONTENT_MISMATCH' });
});
test('Gitea redirects are not followed and errors do not leak credentials', async t => {
  const f = await fixture(t, { '/api/v1/repos/alice/sandbox/branches/work': { redirect: 'http://example.invalid/secret' } });
  await assert.rejects(f.repo.head('alice', 'sandbox', 'work'), e => {
    assert.equal(e.code, 'GITEA_UNAVAILABLE'); assert.ok(!String(e).includes('unit-test-secret')); return true;
  });
  assert.equal(f.requests.length, 1);
});

test('Gitea adapter requires the nested commit tree returned by its API', async t => {
  const f = await fixture(t);
  f.responses[`/api/v1/repos/alice/sandbox/git/commits/${commit}`] = { sha: commit, tree: { sha: rootTree }, parents: [] };
  await assert.rejects(f.repo.read(target, commit), { code: 'INVALID_INPUT' });
  assert.equal(f.requests.length, 1);
});
