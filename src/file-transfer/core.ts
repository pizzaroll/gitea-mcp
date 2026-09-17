import { createHash } from 'node:crypto';

export const MAX_FILE = 4_000_000;
export const MAX_UPLOAD = 6_000_000;
export const HASH = /^[a-f0-9]{64}$/;
export const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export class FileChangeError extends Error {
  constructor(public readonly code: string, message: string,
    public readonly details: Record<string, unknown> = {}) { super(message); }
}
export function check(ok: unknown, code: string, message: string,
  details: Record<string, unknown> = {}): asserts ok {
  if (!ok) throw new FileChangeError(code, message, details);
}
export const sha256 = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
export function blobHash(b: Buffer, reference: string): string {
  check(OBJECT_ID.test(reference), 'INVALID_OBJECT_ID', 'Invalid native Git object ID');
  return createHash(reference.length === 40 ? 'sha1' : 'sha256')
    .update(`blob ${b.length}\0`).update(b).digest('hex');
}
export function object(v: unknown): Record<string, unknown> {
  check(v !== null && typeof v === 'object' && !Array.isArray(v), 'INVALID_INPUT', 'Expected an object');
  return v as Record<string, unknown>;
}
export function text(v: unknown, name: string, max = 1024): string {
  check(typeof v === 'string' && v.length > 0 && v.length <= max, 'INVALID_INPUT', `Invalid ${name}`);
  return v;
}
export function fields(o: Record<string, unknown>, allowed: string[]): void {
  check(Object.keys(o).every(k => allowed.includes(k)), 'INVALID_INPUT', 'Unknown field');
}
export function hash(v: unknown, name: string): string {
  const s = text(v, name, 64);
  check(HASH.test(s), 'INVALID_HASH', `${name} must be 64 lowercase hex characters`);
  return s;
}
export function repoName(v: unknown): string {
  const s = text(v, 'repository coordinate', 100);
  check(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s) && !s.includes('..'), 'INVALID_PATH', 'Invalid repository coordinate');
  return s;
}
export function repoPath(v: unknown): string {
  const s = text(v, 'repository-relative path', 1024);
  check(!/[\\:%?#\x00-\x1f\x7f]/.test(s) && s.split('/').every(p =>
    p !== '' && p !== '.' && p !== '..' && p.toLowerCase() !== '.git' && !/[. ]$/.test(p)),
  'INVALID_PATH', 'Use a repository-relative regular-file path without traversal or .git internals');
  return s;
}
export function refName(v: unknown): string {
  const s = text(v, 'ref', 255);
  check(!/[\\\s~^:?*\[\x00-\x1f\x7f%#]/.test(s) && !s.includes('..') && !s.includes('@{') &&
    s !== '@' && !s.startsWith('-') && s.split('/').every(p => p && !p.startsWith('.') &&
      !p.endsWith('.') && !p.endsWith('.lock')), 'INVALID_REF', 'Invalid branch/ref');
  return s;
}
export function base64(v: unknown): Buffer {
  check(typeof v === 'string' && v.length <= MAX_UPLOAD * 2, 'INVALID_BASE64', 'Invalid base64');
  check(v.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(v) && !/=/.test(v.slice(0, -2)),
    'INVALID_BASE64', 'Expected canonical padded base64');
  const b = Buffer.from(v, 'base64');
  check(b.toString('base64') === v, 'INVALID_BASE64', 'Non-canonical base64');
  return b;
}

// Unlike JSON.parse alone, reject duplicate decoded keys, invalid UTF-8, and deep nesting.
export function strictJSON(bytes: Uint8Array): unknown {
  let s: string;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new FileChangeError('INVALID_JSON', 'Invalid UTF-8'); }
  let i = 0;
  const ws = () => { while (/[\t\n\r ]/.test(s[i] ?? 'x')) i++; };
  const str = (): string => {
    const start = i++;
    while (i < s.length) {
      const c = s[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') return JSON.parse(s.slice(start, i)) as string;
    }
    throw new Error('Unterminated string');
  };
  const value = (depth: number): unknown => {
    if (depth > 64) throw new Error('Too deeply nested');
    ws();
    if (s[i] === '"') return str();
    if (s[i] === '{') {
      i++; ws(); const out: Record<string, unknown> = Object.create(null);
      if (s[i] === '}') { i++; return out; }
      while (true) {
        ws(); if (s[i] !== '"') throw new Error('Expected key');
        const key = str(); ws();
        if (Object.hasOwn(out, key) || s[i++] !== ':') throw new Error('Duplicate key or missing colon');
        out[key] = value(depth + 1); ws();
        if (s[i] === '}') { i++; return out; }
        if (s[i++] !== ',') throw new Error('Expected comma');
      }
    }
    if (s[i] === '[') {
      i++; ws(); const out: unknown[] = [];
      if (s[i] === ']') { i++; return out; }
      while (true) {
        out.push(value(depth + 1)); ws();
        if (s[i] === ']') { i++; return out; }
        if (s[i++] !== ',') throw new Error('Expected comma');
      }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    if (!m) throw new Error('Invalid value');
    i += m[0].length; return JSON.parse(m[0]) as unknown;
  };
  try { const v = value(0); ws(); if (i !== s.length) throw new Error('Trailing data'); return v; }
  catch { throw new FileChangeError('INVALID_JSON', 'Malformed, duplicate-key, or excessively nested JSON'); }
}

// Ported from the supplied Go gitea-file-actions 0.1.0. Offsets address ORIGINAL bytes.
export function applyBytePatch(source: Buffer, artifact: Buffer, resultHash: string): Buffer {
  check(source.length <= MAX_FILE && artifact.length <= MAX_UPLOAD, 'TOO_LARGE', 'Input exceeds limit');
  const p = object(strictJSON(artifact));
  fields(p, ['format', 'source_sha256', 'result_sha256', 'operations']);
  check(p.format === 'gitea-byte-patch-v1', 'INVALID_PATCH', 'Expected gitea-byte-patch-v1');
  check(hash(p.source_sha256, 'source_sha256') === sha256(source), 'SOURCE_HASH_MISMATCH', 'Patch source differs');
  check(hash(p.result_sha256, 'result_sha256') === hash(resultHash, 'result_sha256'), 'RESULT_HASH_MISMATCH', 'Patch result differs');
  check(Array.isArray(p.operations) && p.operations.length > 0 && p.operations.length <= 4096,
    'INVALID_PATCH', 'Expected 1-4096 operations');
  let cursor = 0, last = -1, size = 0;
  const chunks: Buffer[] = [];
  for (const entry of p.operations) {
    const op = object(entry); fields(op, ['offset', 'delete_bytes', 'expected_sha256', 'data_base64']);
    const start = op.offset, count = op.delete_bytes;
    check(typeof start === 'number' && Number.isSafeInteger(start) && typeof count === 'number' &&
      Number.isSafeInteger(count) && start >= cursor && start > last && start <= source.length &&
      count >= 0 && count <= source.length - start, 'INVALID_PATCH_RANGE', 'Ranges must be ordered, valid and non-overlapping');
    check(hash(op.expected_sha256, 'expected_sha256') === sha256(source.subarray(start, start + count)),
      'PATCH_CONTEXT_MISMATCH', 'Deleted bytes differ');
    const insert = base64(op.data_base64);
    check(count > 0 || insert.length > 0, 'INVALID_PATCH', 'Empty operation');
    size += start - cursor + insert.length;
    check(size <= MAX_FILE, 'TOO_LARGE', 'Result exceeds limit');
    chunks.push(source.subarray(cursor, start), insert); cursor = start + count; last = start;
  }
  check(size + source.length - cursor <= MAX_FILE, 'TOO_LARGE', 'Result exceeds limit');
  chunks.push(source.subarray(cursor));
  const result = Buffer.concat(chunks);
  check(sha256(result) === resultHash, 'RESULT_HASH_MISMATCH', 'Final bytes differ');
  return result;
}
export function changeSummary(before: Buffer, after: Buffer) {
  let start = 0, a = before.length, b = after.length;
  while (start < a && start < b && before[start] === after[start]) start++;
  while (a > start && b > start && before[a - 1] === after[b - 1]) { a--; b--; }
  return { offset: start, removed_bytes: a - start, inserted_bytes: b - start,
    before_preview: before.subarray(start, Math.min(a, start + 1500)).toString('utf8'),
    after_preview: after.subarray(start, Math.min(b, start + 1500)).toString('utf8'),
    preview_truncated: a - start > 1500 || b - start > 1500,
    note: 'Common-prefix/suffix byte window, not a minimal unified diff. Download both complete files for exact review.' };
}
