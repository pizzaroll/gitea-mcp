import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, FileChangeError } from '../build/file-transfer/core.js';
import { ChangeStore } from '../build/file-transfer/store.js';
import { ArtifactServer } from '../build/file-transfer/transfer.js';
import { FileChangeService } from '../build/file-transfer/service.js';
export const blob = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
export const sourceInput = { instanceId: 'test', owner: 'alice', repository: 'sandbox', path: 'src/large.ts', ref: 'work' };
export function splicePatch(before, after) {
  let start = 0, a = before.length, b = after.length;
  while (start < a && start < b && before[start] === after[start]) start++;
  while (a > start && b > start && before[a - 1] === after[b - 1]) { a--; b--; }
  return Buffer.from(JSON.stringify({ format: 'gitea-byte-patch-v1', source_sha256: sha256(before),
    result_sha256: sha256(after), operations: [{ offset: start, delete_bytes: a - start,
      expected_sha256: sha256(before.subarray(start, a)), data_base64: after.subarray(start, b).toString('base64') }] }));
}
export class FakeRepository {
  principal = 'test-principal'; current = 'a'.repeat(40); writes = 0; reads = 0;
  beforeUpdate; failWrite = false; forbidden = false;
  constructor(bytes) { this.history = new Map([[this.current, { bytes: Buffer.from(bytes), parents: [] }]]); }
  async resolve() { return this.current; }
  async head() { return this.current; }
  async read(_target, commit) {
    this.reads++;
    if (this.forbidden) throw new FileChangeError('GITEA_FORBIDDEN', 'Denied');
    const entry = this.history.get(commit); if (!entry) throw new Error('No commit');
    return { bytes: Buffer.from(entry.bytes), blob: blob(entry.bytes) };
  }
  async parents(_o, _r, commit) { return this.history.get(commit).parents; }
  move(bytes = this.history.get(this.current).bytes) {
    const commit = sha256(this.current + this.history.size).slice(0, 40);
    this.history.set(commit, { bytes: Buffer.from(bytes), parents: [this.current] }); this.current = commit; return commit;
  }
  async update(_target, _branch, expectedBlob, bytes, message) {
    this.writes++; await this.beforeUpdate?.();
    if (blob(this.history.get(this.current).bytes) !== expectedBlob) throw new FileChangeError('GITEA_CONFLICT', 'Blob moved');
    this.message = message; const commit = this.move(bytes);
    if (this.failWrite) throw new Error('Connection lost after successful write');
    return commit;
  }
}
export async function environment(t, bytes = Buffer.from('original\r\n')) {
  const dir = mkdtempSync(join(tmpdir(), 'gitea-files-'));
  const store = new ChangeStore(dir), artifacts = new ArtifactServer('https://files.example.test/file-transfer');
  const port = await artifacts.listen(0, '127.0.0.1'), repo = new FakeRepository(bytes);
  const service = new FileChangeService(store, () => repo, artifacts, async file => file.bytes);
  t.after(async () => { await artifacts.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const fetchFile = async f => {
    const response = await fetch(`http://127.0.0.1:${port}${new URL(f.download_url).pathname}`);
    return { response, bytes: Buffer.from(await response.arrayBuffer()) };
  };
  const prepare = async (after, overrides = {}) => {
    const snapshot = await service.exportSource(sourceInput), patch = splicePatch(bytes, after);
    const args = { snapshot_id: snapshot.snapshot_id, file: { bytes: patch }, mode: 'byte_patch',
      expected_source_sha256: sha256(bytes), upload_sha256: sha256(patch), result_sha256: sha256(after), message: 'Fix exact bytes', ...overrides };
    return { snapshot, patch, args, change: await service.prepare(args) };
  };
  return { dir, store, artifacts, port, repo, service, fetchFile, prepare };
}
