import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { GiteaFileApi, type GiteaInstanceLike, type Snapshot } from './gitea-file-api.js';
import { applyBytePatch, decodeStrictBase64, FileTransferError, isObjectId, MAX_FILE_BYTES, requireSha256, requireString, reviewWindow, sha256, validateRepoPath } from './file-transfer-core.js';
import { fileTransferToolDefinitions } from './file-transfer-tools.js';

const CHANGE_TTL_MS = 60 * 60 * 1000;
const MAX_STAGED_CHANGES = 16;

type ToolResult = { content: any[]; isError?: boolean };

type StagedChange = {
  changeId: string;
  snapshot: Snapshot;
  mode: 'patch' | 'replace';
  uploadSha256: string;
  resultSha256: string;
  reviewSha256: string;
  message: string;
  before: Buffer;
  after: Buffer;
  createdAtMs: number;
  status: 'staged' | 'publishing' | 'committed' | 'publication_unknown';
  commitSha?: string;
  commitParentSha?: string;
  branchMovedDuringPublication?: boolean;
};

function toolError(error: unknown): ToolResult {
  const e = error instanceof FileTransferError ? error : new FileTransferError('FILE_TRANSFER_ERROR', error instanceof Error ? error.message : 'Unknown file-transfer error');
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ success: false, code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, null, 2) }] };
}

function jsonResult(value: unknown, additional: any[] = []): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }, ...additional] };
}

function reviewHash(change: Pick<StagedChange, 'changeId' | 'snapshot' | 'mode' | 'uploadSha256' | 'resultSha256' | 'message'>): string {
  return sha256(Buffer.from(JSON.stringify(change), 'utf8'));
}

export class FileTransferManager {
  private readonly changes = new Map<string, StagedChange>();

  handles(name: string): boolean {
    return fileTransferToolDefinitions.some(tool => tool.name === name);
  }

  private gc(): void {
    const cutoff = Date.now() - CHANGE_TTL_MS;
    for (const [id, change] of this.changes) if (change.createdAtMs < cutoff) this.changes.delete(id);
  }

  private instance(instances: GiteaInstanceLike[], id: unknown): GiteaInstanceLike {
    const instanceId = requireString(id, 'instanceId', 256);
    const instance = instances.find(item => item.id === instanceId);
    if (!instance) throw new FileTransferError('INSTANCE_NOT_FOUND', `Gitea instance '${instanceId}' not found`);
    return instance;
  }

  async handle(name: string, args: any, instances: GiteaInstanceLike[]): Promise<ToolResult> {
    try {
      this.gc();
      if (name === 'export_source_file') return await this.exportSource(args, instances);
      if (name === 'prepare_file_change') return await this.prepare(args, instances);
      if (name === 'get_file_change') return this.getChange(args);
      if (name === 'commit_file_change') return await this.commit(args, instances);
      throw new FileTransferError('UNKNOWN_TOOL', `Unknown file-transfer tool: ${name}`);
    } catch (error) {
      return toolError(error);
    }
  }

  private async exportSource(args: any, instances: GiteaInstanceLike[]): Promise<ToolResult> {
    const instance = this.instance(instances, args.instanceId);
    const owner = requireString(args.owner, 'owner', 256);
    const repository = requireString(args.repository, 'repository', 256);
    const repoPath = validateRepoPath(args.path);
    const requestedRef = requireString(args.ref, 'ref', 512);
    const api = new GiteaFileApi(instance);
    const resolved = await api.resolveRef(owner, repository, requestedRef);
    const file = await api.readFile(owner, repository, repoPath, resolved.commitSha);
    const snapshot: Snapshot = {
      snapshotId: randomBytes(16).toString('hex'), instanceId: instance.id, owner, repository, requestedRef,
      branch: resolved.branch, baseCommitSha: resolved.commitSha, baseBlobSha: file.blobSha,
      sourceSha256: sha256(file.bytes), path: repoPath, sizeBytes: file.size, createdAt: new Date().toISOString()
    };
    const uri = `gitea-file://snapshot/${snapshot.snapshotId}/${encodeURIComponent(path.posix.basename(repoPath))}`;
    return jsonResult({ success: true, snapshot, artifact: { uri, mimeType: 'application/octet-stream', size: file.size } }, [{
      type: 'resource', resource: { uri, mimeType: 'application/octet-stream', blob: file.bytes.toString('base64') }
    }]);
  }

  private async prepare(args: any, instances: GiteaInstanceLike[]): Promise<ToolResult> {
    if (this.changes.size >= MAX_STAGED_CHANGES) throw new FileTransferError('STAGING_LIMIT', 'Too many staged changes; commit or allow old changes to expire');
    const instance = this.instance(instances, args.instanceId);
    const owner = requireString(args.owner, 'owner', 256);
    const repository = requireString(args.repository, 'repository', 256);
    const branch = requireString(args.branch, 'branch', 512);
    const repoPath = validateRepoPath(args.path);
    const baseCommitSha = requireString(args.baseCommitSha, 'baseCommitSha', 128).toLowerCase();
    if (!isObjectId(baseCommitSha)) throw new FileTransferError('INVALID_COMMIT', 'baseCommitSha must be an exact commit SHA');
    const expectedSourceSha256 = requireSha256(args.expectedSourceSha256, 'expectedSourceSha256');
    const uploadSha256 = requireSha256(args.uploadSha256, 'uploadSha256');
    const resultSha256 = requireSha256(args.resultSha256, 'resultSha256');
    if (args.mode !== 'patch' && args.mode !== 'replace') throw new FileTransferError('INVALID_MODE', 'mode must be patch or replace');
    const mode: 'patch' | 'replace' = args.mode;
    const message = requireString(args.message, 'message', 2048);
    const artifact = decodeStrictBase64(args.artifactBase64, 'artifactBase64');
    if (sha256(artifact) !== uploadSha256) throw new FileTransferError('UPLOAD_HASH_MISMATCH', 'Uploaded artifact bytes do not match uploadSha256');

    const api = new GiteaFileApi(instance);
    const source = await api.readFile(owner, repository, repoPath, baseCommitSha);
    const observedSourceSha256 = sha256(source.bytes);
    if (observedSourceSha256 !== expectedSourceSha256) throw new FileTransferError('SOURCE_HASH_MISMATCH', 'Authoritative source does not match expectedSourceSha256', { observedSourceSha256 });
    const currentHead = await api.head(owner, repository, branch);
    if (currentHead !== baseCommitSha) throw new FileTransferError('STALE_BASE', 'Target branch no longer points at the exported base commit', { expectedBaseCommitSha: baseCommitSha, observedHeadSha: currentHead });

    const after = mode === 'patch' ? applyBytePatch(source.bytes, artifact, resultSha256) : artifact;
    if (after.length > MAX_FILE_BYTES) throw new FileTransferError('TOO_LARGE', `Result exceeds ${MAX_FILE_BYTES} bytes`);
    if (sha256(after) !== resultSha256) throw new FileTransferError('RESULT_HASH_MISMATCH', 'Final bytes do not match resultSha256');

    const snapshot: Snapshot = {
      snapshotId: randomBytes(16).toString('hex'), instanceId: instance.id, owner, repository, requestedRef: branch,
      branch, baseCommitSha, baseBlobSha: source.blobSha, sourceSha256: expectedSourceSha256,
      path: repoPath, sizeBytes: source.size, createdAt: new Date().toISOString()
    };
    const changeId = randomBytes(16).toString('hex');
    const hashInput = { changeId, snapshot, mode, uploadSha256, resultSha256, message };
    const change: StagedChange = { ...hashInput, reviewSha256: reviewHash(hashInput), before: source.bytes, after, createdAtMs: Date.now(), status: 'staged' };
    this.changes.set(changeId, change);
    return jsonResult({ success: true, change: this.view(change) });
  }

  private getChange(args: any): ToolResult {
    const change = this.changes.get(requireString(args.changeId, 'changeId', 64));
    if (!change) throw new FileTransferError('CHANGE_NOT_FOUND', 'Staged change not found or expired');
    return jsonResult({ success: true, change: this.view(change) });
  }

  private view(change: StagedChange): Record<string, unknown> {
    return {
      changeId: change.changeId, repository: `${change.snapshot.owner}/${change.snapshot.repository}`,
      instanceId: change.snapshot.instanceId, branch: change.snapshot.branch, baseCommitSha: change.snapshot.baseCommitSha,
      path: change.snapshot.path, baseBlobSha: change.snapshot.baseBlobSha, oldSha256: change.snapshot.sourceSha256,
      newSha256: change.resultSha256, uploadSha256: change.uploadSha256, reviewSha256: change.reviewSha256,
      mode: change.mode, message: change.message, state: change.status, diffSummary: reviewWindow(change.before, change.after),
      publication: change.commitSha ? { commitSha: change.commitSha, parentSha: change.commitParentSha, branchMovedDuringPublication: change.branchMovedDuringPublication ?? false } : null
    };
  }

  private async commit(args: any, instances: GiteaInstanceLike[]): Promise<ToolResult> {
    const changeId = requireString(args.changeId, 'changeId', 64);
    const suppliedReview = requireSha256(args.reviewSha256, 'reviewSha256');
    const change = this.changes.get(changeId);
    if (!change) throw new FileTransferError('CHANGE_NOT_FOUND', 'Staged change not found or expired');
    if (change.reviewSha256 !== suppliedReview) throw new FileTransferError('REVIEW_HASH_MISMATCH', 'reviewSha256 does not identify the staged bytes');
    if (change.status === 'committed') return jsonResult({ success: true, change: this.view(change), idempotent: true });
    if (change.status !== 'staged') throw new FileTransferError('PUBLICATION_STATE', `Change is already in ${change.status} state; do not retry blindly`);

    const api = new GiteaFileApi(this.instance(instances, change.snapshot.instanceId));
    const head = await api.head(change.snapshot.owner, change.snapshot.repository, change.snapshot.branch);
    if (head !== change.snapshot.baseCommitSha) throw new FileTransferError('STALE_BRANCH', 'Branch HEAD moved after staging; re-export and restage the change', { expectedHeadSha: change.snapshot.baseCommitSha, observedHeadSha: head });
    const source = await api.readFile(change.snapshot.owner, change.snapshot.repository, change.snapshot.path, head);
    if (source.blobSha !== change.snapshot.baseBlobSha || sha256(source.bytes) !== change.snapshot.sourceSha256) {
      throw new FileTransferError('STALE_SOURCE', 'Authoritative source bytes/blob changed after staging', { expectedBlobSha: change.snapshot.baseBlobSha, observedBlobSha: source.blobSha, expectedSourceSha256: change.snapshot.sourceSha256, observedSourceSha256: sha256(source.bytes) });
    }

    change.status = 'publishing';
    try {
      const receipt = await api.updateFile(change.snapshot, change.after, change.message);
      change.commitSha = receipt.commitSha;
      change.commitParentSha = receipt.parentSha;
      change.branchMovedDuringPublication = receipt.parentSha !== change.snapshot.baseCommitSha;
      const published = await api.readFile(change.snapshot.owner, change.snapshot.repository, change.snapshot.path, receipt.commitSha);
      if (sha256(published.bytes) !== change.resultSha256) {
        change.status = 'publication_unknown';
        throw new FileTransferError('POST_COMMIT_VERIFICATION_FAILED', 'Commit exists but exact published bytes did not match staged result; inspect repository history before retrying');
      }
      change.status = 'committed';
      return jsonResult({
        success: true, publicationStatus: 'committed', repository: `${change.snapshot.owner}/${change.snapshot.repository}`,
        branch: change.snapshot.branch, changedPaths: [change.snapshot.path], resultingCommitSha: receipt.commitSha,
        resultingSourceSha256: change.resultSha256, reviewSha256: change.reviewSha256,
        branchMovedDuringPublication: change.branchMovedDuringPublication,
        concurrencyNote: 'Gitea contents API validates the file blob SHA but does not expose an atomic expected-branch-HEAD field; this implementation prechecks HEAD and records whether the returned commit parent still matched the staged base.'
      });
    } catch (error) {
      if (change.status === 'publishing') change.status = 'publication_unknown';
      throw error;
    }
  }
}
