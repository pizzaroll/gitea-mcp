import { loadConfig } from '../config/index.js';
import { check, fields, FileChangeError, object, sha256, text } from './core.js';
import { FileRepository } from './repository.js';
import { ChangeStore } from './store.js';
import { ArtifactServer, downloadUpload } from './transfer.js';
import { FileChangeService, type ExportInput, type PrepareInput } from './service.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

const string = { type: 'string' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const nullableString = { type: ['string', 'null'] };
const artifact = { type: 'object', additionalProperties: false,
  properties: { download_url: string, file_name: string, mime_type: string,
    size_bytes: { type: 'integer' }, sha256: digest, expires_at: string },
  required: ['download_url', 'file_name', 'mime_type', 'size_bytes', 'sha256', 'expires_at'] };
const source = { instanceId: string, owner: string, repository: string, path: string,
  requested_ref: string, branch: nullableString, base_commit_sha: string, blob_sha: string,
  source_sha256: digest, size_bytes: { type: 'integer' } };
const receipt = { ...source, change_id: digest, review_sha256: digest, upload_sha256: digest,
  result_sha256: digest, message: string, publication_message: string, mode: string, status: string,
  commit_sha: nullableString, changed_paths: { type: 'array', items: string }, observed_head: nullableString,
  observed_parents: { type: ['array', 'null'], items: string }, publication_error: nullableString,
  expires_at: string, concurrency_guarantee: string };
const review = { ...receipt, before_file: artifact, after_file: artifact, diff: {
  type: 'object', additionalProperties: false,
  properties: { offset: { type: 'integer' }, removed_bytes: { type: 'integer' }, inserted_bytes: { type: 'integer' },
    before_preview: string, after_preview: string, preview_truncated: { type: 'boolean' }, note: string },
  required: ['offset', 'removed_bytes', 'inserted_bytes', 'before_preview', 'after_preview', 'preview_truncated', 'note'] } };
const schema = (properties: Record<string, unknown>, required = Object.keys(properties)) =>
  ({ type: 'object' as const, properties, required, additionalProperties: false });
const hints = (readOnly: boolean, destructive = false, idempotent = false) =>
  ({ readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: idempotent, openWorldHint: false });
export const fileTransferTools = [
  { name: 'export_source_file',
    description: 'Export exact repository bytes as a downloadable HTTPS file. Save the snapshot ID and hashes. Use a branch ref, or provide branch with an exact commit, before editing. Download and edit locally; never paste large source into tool arguments.',
    inputSchema: schema({ instanceId: string, owner: string, repository: string, path: string, ref: string, branch: string },
      ['instanceId', 'owner', 'repository', 'path', 'ref']),
    outputSchema: schema({ ...source, snapshot_id: digest, resolved_commit_sha: string, snapshot_expires_at: string, file: artifact }),
    annotations: hints(true) },
  { name: 'prepare_file_change',
    description: 'Receive a native ChatGPT file containing a gitea-byte-patch-v1 patch (preferred) or complete replacement. Validate source/upload/result SHA-256 and stage exact bytes WITHOUT committing. Review the returned before/after files and review hash before requesting explicit publication.',
    inputSchema: schema({ snapshot_id: digest, file: { type: 'object', additionalProperties: false,
      properties: { download_url: string, file_id: string, mime_type: string, file_name: string },
      required: ['download_url', 'file_id'] }, mode: { type: 'string', enum: ['byte_patch', 'replace'] },
      expected_source_sha256: digest, upload_sha256: digest, result_sha256: digest, message: string }),
    outputSchema: schema(review), annotations: hints(false), _meta: { 'openai/fileParams': ['file'] } },
  { name: 'get_file_change', description: 'Review a staged change: exact before/after downloads, source and result hashes, commit message, byte diff summary, review hash and publication state. Does not publish.',
    inputSchema: schema({ change_id: digest }), outputSchema: schema(review), annotations: hints(true) },
  { name: 'commit_file_change',
    description: 'Explicitly publish a previously reviewed staged file change. Requires its exact review SHA-256. Reject stale branch/source; never force push or silently merge. Inspect status: only published confirms an unchanged expected parent and HEAD. Unknown/in-flight outcomes never retry the write.',
    inputSchema: schema({ change_id: digest, review_sha256: digest }), outputSchema: schema(receipt),
    annotations: hints(false, true, true) },
];

export class FileTransferRuntime {
  private ready?: Promise<FileChangeService>;
  private store?: ChangeStore;
  private artifacts?: ArtifactServer;
  handles(name: string) { return fileTransferTools.some(t => t.name === name); }
  private initialize(): Promise<FileChangeService> {
    return this.ready ??= (async () => {
      const publicURL = process.env.FILE_TRANSFER_PUBLIC_URL;
      const directory = process.env.FILE_TRANSFER_STATE_DIR;
      check(publicURL && directory, 'FILE_TRANSFER_NOT_CONFIGURED',
        'Set FILE_TRANSFER_PUBLIC_URL and FILE_TRANSFER_STATE_DIR; see docs/FILE-TRANSFER.md');
      const port = Number(process.env.FILE_TRANSFER_PORT ?? '8081');
      check(Number.isInteger(port) && port > 0 && port <= 65535, 'INVALID_CONFIG', 'Invalid FILE_TRANSFER_PORT');
      const hosts = (process.env.FILE_TRANSFER_UPLOAD_HOSTS ?? 'files.oaiusercontent.com').split(',').map(s => s.trim());
      check(hosts.length > 0 && hosts.every(h => /^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(h)),
        'INVALID_CONFIG', 'Use exact lowercase upload hostnames, not wildcards or URLs');
      this.artifacts = new ArtifactServer(publicURL); this.store = new ChangeStore(directory);
      if (process.env.FILE_TRANSFER_SHARED_HTTP !== 'true') {
        try { await this.artifacts.listen(port, process.env.FILE_TRANSFER_HOST ?? '127.0.0.1'); }
        catch { this.store.close(); throw new FileChangeError('LISTEN_FAILED', 'Cannot bind artifact listener'); }
      }
      const repositories = new Map<string, FileRepository>();
      return new FileChangeService(this.store, instanceId => {
        const instance = loadConfig().gitea.instances.find(i => i.id === instanceId);
        check(instance, 'UNKNOWN_INSTANCE', 'Unknown configured Gitea instance');
        const principal = sha256(JSON.stringify([instance.id, instance.baseUrl, instance.token]));
        const key = instanceId + ':' + principal;
        let repository = repositories.get(key);
        if (!repository) { repository = new FileRepository(instance, principal); repositories.set(key, repository); }
        return repository;
      }, this.artifacts, file => downloadUpload(file, hosts));
    })();
  }
  async call(name: string, args: unknown) {
    try {
      const tool = fileTransferTools.find(t => t.name === name); check(tool, 'UNKNOWN_TOOL', 'Unknown file transfer tool');
      const input = object(args); fields(input, Object.keys(tool.inputSchema.properties));
      for (const key of tool.inputSchema.required) check(Object.hasOwn(input, key), 'INVALID_INPUT', `Missing ${key}`);
      const service = await this.initialize();
      let data: Record<string, unknown>;
      if (name === 'export_source_file') data = await service.exportSource(input as unknown as ExportInput);
      else if (name === 'prepare_file_change') data = await service.prepare(input as unknown as PrepareInput);
      else if (name === 'get_file_change') data = await service.get(text(input.change_id, 'change_id', 64));
      else data = await service.commit(text(input.change_id, 'change_id', 64), text(input.review_sha256, 'review_sha256', 64));
      const links = ['file', 'before_file', 'after_file'].filter(key => data[key]).map(key => {
        const f = object(data[key]);
        return { type: 'resource_link' as const, uri: String(f.download_url), name: String(f.file_name),
          mimeType: String(f.mime_type), size: Number(f.size_bytes),
          description: `Exact bytes; SHA-256 ${String(f.sha256)}; expires ${String(f.expires_at)}` };
      });
      return { structuredContent: data, content: [{ type: 'text' as const, text: JSON.stringify(data) }, ...links] };
    } catch (error) {
      const safe = error instanceof FileChangeError ? { code: error.code, message: error.message, details: error.details } :
        { code: 'FILE_TRANSFER_ERROR', message: 'Operation failed; inspect private server diagnostics without exposing credentials' };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(safe) }] };
    }
  }
  handleArtifactRequest(req: IncomingMessage, res: ServerResponse): boolean {
    return this.artifacts?.handleRequest(req, res) ?? false;
  }
  async close() { const service = await this.ready?.catch(() => undefined); await service?.drain(); await this.artifacts?.close(); this.store?.close(); }
}
export const fileTransferRuntime = new FileTransferRuntime();
