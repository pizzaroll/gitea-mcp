import { base64, blobHash, check, FileChangeError, MAX_FILE, object, OBJECT_ID, repoName, repoPath, refName } from './core.js';

export interface Target { owner: string; repository: string; path: string }
export interface SourceFile { bytes: Buffer; blob: string }
export interface Repository {
  readonly principal: string;
  resolve(owner: string, repository: string, ref: string): Promise<string>;
  head(owner: string, repository: string, branch: string): Promise<string>;
  read(target: Target, commit: string): Promise<SourceFile>;
  update(target: Target, branch: string, blob: string, bytes: Buffer, message: string): Promise<string>;
  parents(owner: string, repository: string, commit: string): Promise<string[]>;
}
interface Instance {
  baseUrl: string; token: string; timeout: number;
  rateLimit: { requests: number; windowMs: number };
}
const oid = (v: unknown): string => {
  check(typeof v === 'string' && OBJECT_ID.test(v), 'INVALID_GITEA_RESPONSE', 'Missing immutable Git object ID'); return v;
};
const prefix = (owner: string, repository: string) => `/api/v1/repos/${encodeURIComponent(repoName(owner))}/${encodeURIComponent(repoName(repository))}`;

// Uses the same configured instance/token as the existing tools. No retries on writes.
export class FileRepository implements Repository {
  private readonly base: string;
  private calls: number[] = [];
  constructor(private readonly instance: Instance, public readonly principal: string,
    private readonly request: typeof fetch = fetch) {
    const url = new URL(instance.baseUrl);
    check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
      'INVALID_CONFIG', 'Invalid configured Gitea URL');
    this.base = url.toString().replace(/\/$/, '');
  }
  private async api(endpoint: string, method = 'GET', body?: unknown): Promise<Record<string, unknown>> {
    const now = Date.now();
    this.calls = this.calls.filter(t => t > now - this.instance.rateLimit.windowMs);
    check(this.calls.length < this.instance.rateLimit.requests, 'RATE_LIMITED', 'Configured Gitea request limit reached');
    this.calls.push(now);
    try {
      const response = await this.request(this.base + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(this.instance.timeout),
        headers: { Authorization: `token ${this.instance.token}`, Accept: 'application/json',
          'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      const code = response.status === 404 ? 'GITEA_NOT_FOUND' : [401, 403].includes(response.status) ?
        'GITEA_FORBIDDEN' : [409, 422].includes(response.status) ? 'GITEA_CONFLICT' : 'GITEA_ERROR';
      if (!response.ok) { await response.body?.cancel(); throw new FileChangeError(code, 'Gitea rejected the request', { status: response.status }); }
      check(response.body, 'INVALID_GITEA_RESPONSE', 'Empty Gitea response');
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.length;
          check(length <= MAX_FILE * 2 + 1_000_000, 'TOO_LARGE', 'Gitea response exceeds limit');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    } catch (error) {
      if (error instanceof FileChangeError) throw error;
      // Never leak credentials, upstream response bodies or signed URLs.
      throw new FileChangeError('GITEA_UNAVAILABLE', 'Gitea request failed; a write outcome may be unknown');
    }
  }
  private async commit(owner: string, repository: string, ref: string) {
    return this.api(`${prefix(owner, repository)}/git/commits/${encodeURIComponent(refName(ref))}`);
  }
  async resolve(owner: string, repository: string, ref: string): Promise<string> {
    return oid((await this.commit(owner, repository, ref)).sha);
  }
  async head(owner: string, repository: string, branch: string): Promise<string> {
    const r = await this.api(`${prefix(owner, repository)}/branches/${encodeURIComponent(refName(branch))}`);
    return oid(object(r.commit).id);
  }
  async parents(owner: string, repository: string, commit: string): Promise<string[]> {
    const r = await this.commit(owner, repository, oid(commit));
    check(oid(r.sha) === commit && Array.isArray(r.parents), 'INVALID_GITEA_RESPONSE', 'Invalid commit receipt');
    return r.parents.map(p => oid(object(p).sha));
  }
  async read(target: Target, commit: string): Promise<SourceFile> {
    const parts = repoPath(target.path).split('/');
    check(parts.length <= 64, 'INVALID_PATH', 'Path depth exceeds limit');
    const root = await this.commit(target.owner, target.repository, oid(commit));
    check(oid(root.sha) === commit, 'INVALID_GITEA_RESPONSE', 'Resolved source commit differs');
    // Gitea wraps raw commit metadata in `commit`; the immutable tree is nested.
    let tree = oid(object(object(root.commit).tree).sha), blob = '';
    // Walk immutable trees. Never follow symlinks, including parent components, or gitlinks.
    for (let depth = 0; depth < parts.length; depth++) {
      let entry: Record<string, unknown> | undefined;
      for (let page = 1; page <= 20; page++) {
        const r = await this.api(`${prefix(target.owner, target.repository)}/git/trees/${tree}?recursive=false&per_page=1000&page=${page}`);
        check(Array.isArray(r.tree), 'INVALID_GITEA_RESPONSE', 'Missing tree entries');
        entry = r.tree.map(object).find(e => e.path === parts[depth]);
        if (entry || (!r.truncated && r.tree.length < 1000)) break;
        check(page < 20, 'TREE_LIMIT', 'Directory too large to inspect safely');
      }
      check(entry, 'GITEA_NOT_FOUND', 'File path not found at the exact commit');
      const final = depth === parts.length - 1;
      check(final ? entry.type === 'blob' && ['100644', '100755'].includes(String(entry.mode)) :
        entry.type === 'tree' && ['040000', '40000'].includes(String(entry.mode)),
      'NOT_REGULAR_FILE', 'Symlinks, submodules and non-regular paths are not supported');
      tree = oid(entry.sha); if (final) blob = tree;
    }
    const r = await this.api(`${prefix(target.owner, target.repository)}/git/blobs/${blob}`);
    check(r.encoding === 'base64' && typeof r.content === 'string' && typeof r.size === 'number' &&
      Number.isSafeInteger(r.size) && r.size >= 0 && r.size <= MAX_FILE,
    'INVALID_GITEA_RESPONSE', 'Invalid or oversized blob');
    const bytes = base64(r.content.replace(/[\r\n]/g, ''));
    check(bytes.length === r.size && blobHash(bytes, blob) === blob && (r.sha === undefined || r.sha === blob),
      'GITEA_CONTENT_MISMATCH', 'Source bytes differ from native blob identity');
    check(!bytes.subarray(0, 43).toString().startsWith('version https://git-lfs.github.com/spec/v1'),
      'LFS_NOT_SUPPORTED', 'LFS pointers are not source files');
    return { bytes, blob };
  }
  async update(target: Target, branch: string, blob: string, bytes: Buffer, message: string): Promise<string> {
    check(bytes.length <= MAX_FILE, 'TOO_LARGE', 'Result exceeds limit');
    const escaped = repoPath(target.path).split('/').map(encodeURIComponent).join('/');
    const r = await this.api(`${prefix(target.owner, target.repository)}/contents/${escaped}`, 'PUT', {
      branch: refName(branch), sha: oid(blob), content: bytes.toString('base64'), message
    });
    // Native blob SHA is the API's file guard; it is NOT atomic branch-HEAD CAS.
    return oid(object(r.commit).sha);
  }
}
