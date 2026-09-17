import { FileTransferError, MAX_FILE_BYTES, decodeStrictBase64, encodeRepoPath, gitBlobSha, isObjectId, requireString } from './file-transfer-core.js';

export interface GiteaInstanceLike {
  id: string;
  baseUrl: string;
  token: string;
  timeout?: number;
}

export interface RepoFile {
  bytes: Buffer;
  blobSha: string;
  size: number;
}

export interface Snapshot {
  snapshotId: string;
  instanceId: string;
  owner: string;
  repository: string;
  requestedRef: string;
  branch: string;
  baseCommitSha: string;
  baseBlobSha: string;
  sourceSha256: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export class GiteaFileApi {
  private readonly instance: GiteaInstanceLike;

  constructor(instance: GiteaInstanceLike) {
    this.instance = instance;
  }

  private async request(method: string, endpoint: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.instance.timeout ?? 30_000);
    try {
      const response = await fetch(`${this.instance.baseUrl.replace(/\/$/, '')}${endpoint}`, {
        method,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `token ${this.instance.token}`,
          'User-Agent': 'Gitea-MCP-File-Transfer/1.0'
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if (!response.ok) {
        if (response.status === 404) throw new FileTransferError('GITEA_NOT_FOUND', 'Gitea could not find the requested repository object');
        if (response.status === 401 || response.status === 403) throw new FileTransferError('GITEA_FORBIDDEN', 'Gitea rejected the configured account or repository permission');
        if (response.status === 409 || response.status === 422) throw new FileTransferError('GITEA_CONFLICT', 'Gitea rejected a conflicting or stale file update');
        throw new FileTransferError('GITEA_ERROR', `Gitea returned HTTP ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      if (error instanceof FileTransferError) throw error;
      throw new FileTransferError('GITEA_UNAVAILABLE', 'Gitea request failed; write outcome may be unknown');
    } finally {
      clearTimeout(timeout);
    }
  }

  private repo(owner: string, repository: string): string {
    return `/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  }

  async resolveRef(owner: string, repository: string, requestedRef: string): Promise<{ commitSha: string; branch: string }> {
    const ref = requireString(requestedRef, 'ref', 512);
    try {
      const branch = await this.request('GET', `${this.repo(owner, repository)}/branches/${encodeURIComponent(ref)}`);
      const commitSha = branch?.commit?.id ?? branch?.commit?.sha;
      if (!isObjectId(commitSha)) throw new FileTransferError('INVALID_GITEA_RESPONSE', 'Branch response did not contain an immutable commit SHA');
      return { commitSha: commitSha.toLowerCase(), branch: ref };
    } catch (error) {
      if (!(error instanceof FileTransferError) || error.code !== 'GITEA_NOT_FOUND') throw error;
    }
    const commit = await this.request('GET', `${this.repo(owner, repository)}/git/commits/${encodeURIComponent(ref)}`);
    const commitSha = commit?.sha ?? commit?.id;
    if (!isObjectId(commitSha)) throw new FileTransferError('INVALID_GITEA_RESPONSE', 'Ref did not resolve to an immutable commit SHA');
    return { commitSha: commitSha.toLowerCase(), branch: '' };
  }

  async head(owner: string, repository: string, branch: string): Promise<string> {
    const data = await this.request('GET', `${this.repo(owner, repository)}/branches/${encodeURIComponent(branch)}`);
    const sha = data?.commit?.id ?? data?.commit?.sha;
    if (!isObjectId(sha)) throw new FileTransferError('INVALID_GITEA_RESPONSE', 'Branch response did not contain a commit SHA');
    return sha.toLowerCase();
  }

  async readFile(owner: string, repository: string, repoPath: string, commitSha: string): Promise<RepoFile> {
    if (!isObjectId(commitSha)) throw new FileTransferError('INVALID_COMMIT', 'An exact commit SHA is required');
    const data = await this.request('GET', `${this.repo(owner, repository)}/contents/${encodeRepoPath(repoPath)}?ref=${encodeURIComponent(commitSha)}`);
    if (data?.type !== 'file' || data?.path !== repoPath || data?.encoding !== 'base64' || typeof data?.content !== 'string' || !isObjectId(data?.sha)) {
      throw new FileTransferError('NOT_REGULAR_FILE', 'Only regular repository files with exact content metadata are supported');
    }
    const size = Number(data.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new FileTransferError('TOO_LARGE', `Source file exceeds ${MAX_FILE_BYTES} bytes`);
    }
    const bytes = decodeStrictBase64(data.content.replace(/\s/g, ''), 'gitea.content', MAX_FILE_BYTES);
    const blobSha = String(data.sha).toLowerCase();
    if (bytes.length !== size || gitBlobSha(bytes, blobSha) !== blobSha) {
      throw new FileTransferError('GITEA_CONTENT_MISMATCH', 'Source bytes do not match Gitea size/blob metadata');
    }
    if (bytes.subarray(0, 42).toString('utf8') === 'version https://git-lfs.github.com/spec/v1') {
      throw new FileTransferError('LFS_NOT_SUPPORTED', 'Git LFS pointer files are not editable through this source bridge');
    }
    return { bytes, blobSha, size };
  }

  async updateFile(snapshot: Snapshot, after: Buffer, message: string): Promise<{ commitSha: string; parentSha: string }> {
    const result = await this.request('PUT', `${this.repo(snapshot.owner, snapshot.repository)}/contents/${encodeRepoPath(snapshot.path)}`, {
      branch: snapshot.branch,
      sha: snapshot.baseBlobSha,
      content: after.toString('base64'),
      message
    });
    const commitSha = result?.commit?.sha ?? result?.commit?.id;
    const parents = result?.commit?.parents;
    const parentSha = Array.isArray(parents) && parents.length === 1 ? (parents[0]?.sha ?? parents[0]?.id) : undefined;
    if (!isObjectId(commitSha) || !isObjectId(parentSha)) {
      throw new FileTransferError('PUBLICATION_UNKNOWN', 'Gitea returned an incomplete commit receipt; inspect repository history before retrying');
    }
    return { commitSha: commitSha.toLowerCase(), parentSha: parentSha.toLowerCase() };
  }
}
