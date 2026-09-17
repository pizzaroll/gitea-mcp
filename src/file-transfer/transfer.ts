import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createServer, type Server } from 'node:http';
import { check, FileChangeError, MAX_FILE, MAX_UPLOAD, object, sha256, text } from './core.js';
import { newID } from './store.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16],
  ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 &&
    globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
export function uploadURL(value: unknown, hosts: readonly string[]): URL {
  let url: URL;
  try { url = new URL(text(value, 'download_url', 8192)); }
  catch { throw new FileChangeError('INVALID_UPLOAD_URL', 'Invalid file download URL'); }
  check(url.protocol === 'https:' && (!url.port || url.port === '443') && !url.username &&
    !url.password && !url.hash && !isIP(url.hostname) && hosts.includes(url.hostname) &&
    !url.hostname.endsWith('.'), 'UNSAFE_UPLOAD_URL', 'Upload URL must use an explicitly allowlisted HTTPS host');
  return url;
}
// Dedicated HTTPS client: no redirects, proxies, credentials, automatic decompression,
// or second DNS lookup. Validate every DNS answer and pin the selected IP for TLS.
export async function downloadUpload(file: unknown, hosts: readonly string[]): Promise<Buffer> {
  const f = object(file); text(f.file_id, 'file_id', 512);
  const url = uploadURL(f.download_url, hosts);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FileChangeError('UPLOAD_TIMEOUT', 'Upload DNS lookup timed out')), 5000);
  });
  let addresses: Awaited<ReturnType<typeof lookup>>[];
  try { addresses = await Promise.race([lookup(url.hostname, { all: true, verbatim: true }), timeout]); }
  catch { throw new FileChangeError('UPLOAD_UNAVAILABLE', 'Upload host lookup failed'); }
  finally { clearTimeout(timer); }
  check(addresses.length > 0 && addresses.every(a => publicAddress(a.address)),
    'UNSAFE_UPLOAD_ADDRESS', 'Upload host resolved to a non-public address');
  const selected = addresses[0];
  return new Promise((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof FileChangeError ? error :
      new FileChangeError('UPLOAD_UNAVAILABLE', 'File download failed; signed URL may have expired'));
    const req = httpsRequest(url, {
      agent: false, family: selected.family, headers: { 'Accept-Encoding': 'identity' },
      lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
    }, response => {
      try {
        check(response.statusCode === 200, 'UPLOAD_HTTP_ERROR', 'Upload URL must return HTTP 200 without redirects');
        check(!response.headers['content-encoding'] || response.headers['content-encoding'] === 'identity',
          'UPLOAD_ENCODING', 'Compressed transfer encoding is not accepted');
        const length = response.headers['content-length'];
        check(length === undefined || (/^\d+$/.test(length) && Number(length) <= MAX_UPLOAD),
          'TOO_LARGE', 'Upload exceeds limit');
      } catch (error) { response.destroy(); req.destroy(); fail(error); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (b: Buffer) => {
        size += b.length;
        if (size > MAX_UPLOAD) { fail(new FileChangeError('TOO_LARGE', 'Upload exceeds limit')); req.destroy(); }
        else chunks.push(b);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', fail);
    });
    const deadline = setTimeout(() => { fail(new FileChangeError('UPLOAD_TIMEOUT', 'Upload timed out')); req.destroy(); }, 15000);
    req.on('close', () => clearTimeout(deadline)); req.on('error', fail); req.end();
  });
}
export interface Artifact {
  download_url: string; file_name: string; mime_type: string; size_bytes: number;
  sha256: string; expires_at: string;
}
export interface Artifacts { add(bytes: Buffer, name: string): Artifact }
// Same MCP process, serving only expiring opaque in-memory capabilities, never disk paths.
export class ArtifactServer implements Artifacts {
  private readonly server: Server;
  private readonly prefix: string;
  private readonly entries = new Map<string, { bytes: Buffer; name: string; expires: number }>();
  constructor(private readonly publicURL: string, private readonly now = Date.now) {
    const url = new URL(publicURL);
    check(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      !/%|\.\./.test(url.pathname), 'INVALID_CONFIG', 'FILE_TRANSFER_PUBLIC_URL must be a clean public HTTPS URL');
    this.publicURL = url.toString().replace(/\/$/, ''); this.prefix = `${url.pathname.replace(/\/$/, '')}/`;
    this.server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const raw = req.url ?? '', id = raw.startsWith(this.prefix) ? raw.slice(this.prefix.length) : '';
      this.gc(); const item = /^[a-f0-9]{64}$/.test(id) ? this.entries.get(id) : undefined;
      if (!['GET', 'HEAD'].includes(req.method ?? '')) { res.writeHead(405); res.end(); return; }
      if (!item) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${item.name}"`);
      res.setHeader('Content-Length', item.bytes.length);
      res.writeHead(200); res.end(req.method === 'HEAD' ? undefined : item.bytes);
    });
    this.server.headersTimeout = 10000; this.server.requestTimeout = 15000; this.server.maxConnections = 32;
  }
  private gc() { for (const [id, v] of this.entries) if (v.expires <= this.now()) this.entries.delete(id); }
  add(bytes: Buffer, name: string): Artifact {
    this.gc();
    check(bytes.length <= MAX_FILE && this.entries.size < 64 &&
      [...this.entries.values()].reduce((n, v) => n + v.bytes.length, bytes.length) <= 32_000_000,
    'ARTIFACT_QUOTA_EXCEEDED', 'Download cache full; retry after links expire');
    const id = newID(), expires = this.now() + 300000;
    const safeName = name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(-150) || 'source.bin';
    this.entries.set(id, { bytes: Buffer.from(bytes), name: safeName, expires });
    return { download_url: `${this.publicURL}/${id}`, file_name: safeName, mime_type: 'application/octet-stream',
      size_bytes: bytes.length, sha256: sha256(bytes), expires_at: new Date(expires).toISOString() };
  }
  async listen(port: number, host: string): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => reject(error);
      this.server.once('error', fail);
      this.server.listen(port, host, () => { this.server.off('error', fail); resolve(); });
    });
    const address = this.server.address();
    check(address && typeof address === 'object', 'LISTEN_FAILED', 'Artifact listener failed'); return address.port;
  }
  async close(): Promise<void> {
    this.entries.clear(); this.server.closeAllConnections();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
