import { applyBytePatch, base64, blobHash, changeSummary, check, FileChangeError, hash,
  MAX_FILE, MAX_UPLOAD, OBJECT_ID, refName, repoName, repoPath, sha256, text } from './core.js';
import { ChangeStore, newID, type RecordBase } from './store.js';
import type { Repository, SourceFile, Target } from './repository.js';
import type { Artifacts } from './transfer.js';

interface Snapshot extends RecordBase, Target {
  kind: 'snapshot'; instanceId: string; principal: string; requested_ref: string;
  branch: string | null; base_commit_sha: string; blob_sha: string; source_sha256: string; size_bytes: number;
}
interface Change extends RecordBase {
  kind: 'change'; snapshot: Snapshot; mode: 'byte_patch' | 'replace';
  upload_sha256: string; result_sha256: string; message: string; review_sha256: string;
  before_base64: string; after_base64: string; status: string; commit_sha?: string;
  observed_head?: string; observed_parents?: string[]; publication_error?: string;
}
export interface ExportInput extends Target { instanceId: string; ref: string; branch?: string }
export interface PrepareInput {
  snapshot_id: string; file: unknown; mode: string; expected_source_sha256: string;
  upload_sha256: string; result_sha256: string; message: string;
}
export class FileChangeService {
  private publication: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: ChangeStore,
    private readonly repository: (instanceId: string) => Repository,
    private readonly artifacts: Artifacts, private readonly upload: (file: unknown) => Promise<Buffer>,
    private readonly now = Date.now) {}
  private metadata(s: Snapshot) {
    return { instanceId: s.instanceId, owner: s.owner, repository: s.repository, path: s.path,
      requested_ref: s.requested_ref, branch: s.branch, base_commit_sha: s.base_commit_sha,
      blob_sha: s.blob_sha, source_sha256: s.source_sha256, size_bytes: s.size_bytes };
  }
  private authorized(s: Snapshot): Repository {
    const repo = this.repository(s.instanceId);
    check(repo.principal === s.principal, 'STATE_PRINCIPAL_CHANGED', 'Instance credentials changed; export again');
    return repo;
  }
  private verifySource(s: Snapshot, source: SourceFile) {
    check(source.bytes.length <= MAX_FILE && source.blob === s.blob_sha &&
      sha256(source.bytes) === s.source_sha256 && blobHash(source.bytes, source.blob) === source.blob,
    'STALE_SOURCE', 'Authoritative source does not match snapshot', {
      expected_blob_sha: s.blob_sha, observed_blob_sha: source.blob,
      expected_source_sha256: s.source_sha256, observed_source_sha256: sha256(source.bytes) });
  }
  private async verifyHead(s: Snapshot, repo: Repository) {
    check(s.branch, 'BRANCH_REQUIRED', 'Export with a target branch to stage a change');
    const head = await repo.head(s.owner, s.repository, s.branch);
    check(head === s.base_commit_sha, 'STALE_BRANCH', 'Branch moved; export current source and rebase the local edit',
      { expected_commit_sha: s.base_commit_sha, observed_commit_sha: head });
  }
  async exportSource(input: ExportInput) {
    const target = { owner: repoName(input.owner), repository: repoName(input.repository), path: repoPath(input.path) };
    const instanceId = text(input.instanceId, 'instanceId', 100), ref = refName(input.ref);
    const repo = this.repository(instanceId), commit = await repo.resolve(target.owner, target.repository, ref);
    check(OBJECT_ID.test(commit), 'INVALID_GITEA_RESPONSE', 'Expected immutable commit');
    let branch: string | null = input.branch ? refName(input.branch) : null;
    if (branch) check(await repo.head(target.owner, target.repository, branch) === commit,
      'STALE_BRANCH', 'Requested branch and ref must resolve to the same commit');
    else if (!OBJECT_ID.test(ref)) {
      try { if (await repo.head(target.owner, target.repository, ref) === commit) branch = ref; }
      catch (error) { if (!(error instanceof FileChangeError && error.code === 'GITEA_NOT_FOUND')) throw error; }
    }
    const source = await repo.read(target, commit);
    check(source.bytes.length <= MAX_FILE && blobHash(source.bytes, source.blob) === source.blob,
      'GITEA_CONTENT_MISMATCH', 'Invalid source bytes');
    const snapshot: Snapshot = { id: newID(), kind: 'snapshot', instanceId, principal: repo.principal,
      ...target, requested_ref: ref, branch, base_commit_sha: commit, blob_sha: source.blob,
      source_sha256: sha256(source.bytes), size_bytes: source.bytes.length, expires_at: this.now() + 3600000 };
    this.store.put(snapshot);
    return { ...this.metadata(snapshot), snapshot_id: snapshot.id, resolved_commit_sha: commit,
      snapshot_expires_at: new Date(snapshot.expires_at).toISOString(),
      file: this.artifacts.add(source.bytes, target.path.split('/').pop()!) };
  }
  async prepare(input: PrepareInput) {
    const s = this.store.get<Snapshot>(input.snapshot_id);
    check(s.kind === 'snapshot', 'NOT_FOUND', 'Source snapshot not found');
    check(input.mode === 'byte_patch' || input.mode === 'replace', 'INVALID_MODE', 'Use byte_patch or replace');
    const expected = hash(input.expected_source_sha256, 'expected_source_sha256');
    const uploadHash = hash(input.upload_sha256, 'upload_sha256'), resultHash = hash(input.result_sha256, 'result_sha256');
    check(expected === s.source_sha256, 'SOURCE_HASH_MISMATCH', 'Expected source differs from snapshot');
    const message = text(input.message, 'message', 2048).trim();
    check(message.length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(message) &&
      !message.includes('Gitea-MCP-Change:'), 'INVALID_MESSAGE', 'Invalid commit message');
    const repo = this.authorized(s); await this.verifyHead(s, repo);
    const source = await repo.read(s, s.base_commit_sha); this.verifySource(s, source);
    const artifact = await this.upload(input.file);
    check(artifact.length <= MAX_UPLOAD, 'TOO_LARGE', 'Upload exceeds limit');
    check(sha256(artifact) === uploadHash, 'UPLOAD_HASH_MISMATCH', 'Uploaded bytes differ');
    const after = input.mode === 'byte_patch' ? applyBytePatch(source.bytes, artifact, resultHash) : artifact;
    check(after.length <= MAX_FILE, 'TOO_LARGE', 'Result exceeds limit');
    check(sha256(after) === resultHash, 'RESULT_HASH_MISMATCH', 'Final bytes differ');
    check(resultHash !== s.source_sha256, 'NO_CHANGE', 'No source change');
    await this.verifyHead(s, repo);
    const c: Change = { id: newID(), kind: 'change', snapshot: s, mode: input.mode,
      upload_sha256: uploadHash, result_sha256: resultHash, message, review_sha256: '',
      before_base64: source.bytes.toString('base64'), after_base64: after.toString('base64'),
      status: 'staged', expires_at: this.now() + 86400000 };
    c.review_sha256 = this.reviewHash(c); this.store.put(c);
    return this.review(c);
  }
  private reviewHash(c: Change): string {
    const s = c.snapshot;
    return sha256(JSON.stringify(['gitea-mcp-review-v1', c.id, s.instanceId, s.principal,
      s.owner, s.repository, s.path, s.branch, s.base_commit_sha, s.blob_sha, s.source_sha256,
      c.mode, c.upload_sha256, c.result_sha256, c.message]));
  }
  private change(id: string): Change {
    const c = this.store.get<Change>(id);
    check(c.kind === 'change', 'NOT_FOUND', 'Staged change not found'); this.authorized(c.snapshot);
    check(c.review_sha256 === this.reviewHash(c) && sha256(base64(c.before_base64)) === c.snapshot.source_sha256 &&
      sha256(base64(c.after_base64)) === c.result_sha256, 'STATE_CORRUPT', 'Staged review or bytes changed');
    return c;
  }
  private receipt(c: Change) {
    return { ...this.metadata(c.snapshot), change_id: c.id, review_sha256: c.review_sha256,
      upload_sha256: c.upload_sha256, result_sha256: c.result_sha256, message: c.message,
      publication_message: `${c.message}\n\nGitea-MCP-Change: ${c.id}`,
      mode: c.mode, status: c.status, commit_sha: c.commit_sha ?? null,
      changed_paths: [c.snapshot.path], observed_head: c.observed_head ?? null,
      observed_parents: c.observed_parents ?? null, publication_error: c.publication_error ?? null,
      expires_at: new Date(c.expires_at).toISOString(),
      concurrency_guarantee: 'Branch preflight + native blob guard; not atomic branch-HEAD compare-and-swap' };
  }
  private review(c: Change) {
    const before = base64(c.before_base64), after = base64(c.after_base64);
    return { ...this.receipt(c), diff: changeSummary(before, after),
      before_file: this.artifacts.add(before, 'before-' + c.snapshot.path.split('/').pop()),
      after_file: this.artifacts.add(after, 'after-' + c.snapshot.path.split('/').pop()) };
  }
  async get(id: string) {
    const c = this.change(id), repo = this.authorized(c.snapshot);
    // Re-check upstream read authorization before releasing stored source bytes.
    this.verifySource(c.snapshot, await repo.read(c.snapshot, c.snapshot.base_commit_sha));
    return this.review(c);
  }
  async drain() { await this.publication; }
  commit(id: string, reviewHash: string) {
    // Serialize publication inside the process; ChangeStore excludes other writers.
    const action = this.publication.then(() => this.publish(id, reviewHash));
    this.publication = action.catch(() => {}); return action;
  }
  private async publish(id: string, reviewHash: string) {
    const c = this.change(id), s = c.snapshot, repo = this.authorized(s);
    check(hash(reviewHash, 'review_sha256') === c.review_sha256, 'REVIEW_MISMATCH', 'Review identifier differs');
    // Unknown/in-flight outcomes must NEVER trigger a second PUT, even after restart.
    if (c.status !== 'staged') return this.receipt(c);
    await this.verifyHead(s, repo); this.verifySource(s, await repo.read(s, s.base_commit_sha));
    await this.verifyHead(s, repo);
    c.status = 'publishing'; this.store.put(c); // durable intent precedes any network write
    try {
      c.commit_sha = await repo.update(s, s.branch!, s.blob_sha, base64(c.after_base64),
        `${c.message}\n\nGitea-MCP-Change: ${c.id}`);
      check(OBJECT_ID.test(c.commit_sha), 'INVALID_GITEA_RESPONSE', 'Missing publication commit');
      c.status = 'publication_unknown'; this.store.put(c); // retain known SHA before verification
      c.observed_parents = await repo.parents(s.owner, s.repository, c.commit_sha);
      const result = await repo.read(s, c.commit_sha);
      check(sha256(result.bytes) === c.result_sha256 && blobHash(result.bytes, result.blob) === result.blob,
        'PUBLICATION_VERIFICATION_FAILED', 'Published source hash differs; inspect the returned commit');
      c.observed_head = await repo.head(s.owner, s.repository, s.branch!);
      c.status = c.observed_parents.length !== 1 || c.observed_parents[0] !== s.base_commit_sha ?
        'published_branch_race' : c.observed_head !== c.commit_sha ? 'published_branch_moved' : 'published';
    } catch (error) {
      c.status = 'publication_unknown';
      c.publication_error = error instanceof FileChangeError ? error.code : 'PUBLICATION_UNCERTAIN';
    }
    this.store.put(c); return this.receipt(c);
  }
}
