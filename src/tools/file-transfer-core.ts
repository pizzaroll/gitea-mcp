import { createHash } from 'node:crypto';
import * as path from 'node:path';

export const MAX_FILE_BYTES = 4_000_000;
export const MAX_ARTIFACT_BYTES = 6_000_000;
export const MAX_OPERATIONS = 4096;

export class FileTransferError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FileTransferError';
    this.code = code;
    this.details = details;
  }
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

export function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new FileTransferError('INVALID_HASH', `${field} must be 64 lowercase hexadecimal characters`);
  }
  return value;
}

export function requireString(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new FileTransferError('INVALID_PARAMS', `${field} is required and must be at most ${max} characters`);
  }
  return value;
}

export function validateRepoPath(input: unknown): string {
  const value = requireString(input, 'path', 4096);
  if (value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new FileTransferError('INVALID_PATH', 'Repository path must be a relative POSIX path');
  }
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..' || segment.toLowerCase() === '.git')) {
    throw new FileTransferError('INVALID_PATH', 'Repository path contains a forbidden segment');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized.startsWith('../') || normalized === '..') {
    throw new FileTransferError('INVALID_PATH', 'Repository path must already be normalized and remain inside the repository');
  }
  return normalized;
}

export function encodeRepoPath(repoPath: string): string {
  return repoPath.split('/').map(encodeURIComponent).join('/');
}

export function gitBlobSha(data: Buffer, referenceSha: string): string {
  const algorithm = referenceSha.length === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm)
    .update(Buffer.from(`blob ${data.length}\0`, 'utf8'))
    .update(data)
    .digest('hex');
}

export function decodeStrictBase64(value: unknown, field: string, maxBytes = MAX_ARTIFACT_BYTES): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new FileTransferError('INVALID_ARTIFACT', `${field} is required`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new FileTransferError('INVALID_ARTIFACT', `${field} must be canonical base64`);
  }
  const data = Buffer.from(value, 'base64');
  if (data.length > maxBytes || data.toString('base64') !== value) {
    throw new FileTransferError('TOO_LARGE', `${field} exceeds the allowed size or is not canonical base64`);
  }
  return data;
}

interface BytePatch {
  format: string;
  source_sha256: string;
  result_sha256: string;
  operations: Array<{
    offset: number;
    delete_bytes: number;
    expected_sha256: string;
    data_base64: string;
  }>;
}

export function applyBytePatch(source: Buffer, artifact: Buffer, expectedResultSha256: string): Buffer {
  if (source.length > MAX_FILE_BYTES || artifact.length > MAX_ARTIFACT_BYTES) {
    throw new FileTransferError('TOO_LARGE', 'Patch input exceeds configured limits');
  }
  let patch: BytePatch;
  try {
    patch = JSON.parse(artifact.toString('utf8')) as BytePatch;
  } catch {
    throw new FileTransferError('INVALID_PATCH', 'Malformed byte-patch JSON');
  }
  if (!patch || patch.format !== 'gitea-byte-patch-v1' || !Array.isArray(patch.operations)) {
    throw new FileTransferError('INVALID_PATCH', 'Expected gitea-byte-patch-v1 byte patch');
  }
  if (requireSha256(patch.source_sha256, 'patch.source_sha256') !== sha256(source)) {
    throw new FileTransferError('SOURCE_HASH_MISMATCH', 'Patch was generated for different source bytes');
  }
  if (requireSha256(patch.result_sha256, 'patch.result_sha256') !== expectedResultSha256) {
    throw new FileTransferError('RESULT_HASH_MISMATCH', 'Patch result hash differs from requested result');
  }
  if (patch.operations.length === 0 || patch.operations.length > MAX_OPERATIONS) {
    throw new FileTransferError('INVALID_PATCH', `Patch must contain 1-${MAX_OPERATIONS} operations`);
  }

  const chunks: Buffer[] = [];
  let cursor = 0;
  let lastOffset = -1;
  let outputBytes = 0;
  for (const op of patch.operations) {
    if (!Number.isSafeInteger(op.offset) || !Number.isSafeInteger(op.delete_bytes) || op.offset < cursor || op.offset <= lastOffset || op.offset > source.length || op.delete_bytes < 0 || op.delete_bytes > source.length - op.offset) {
      throw new FileTransferError('INVALID_PATCH_RANGE', 'Operations must be ordered, non-overlapping original-file byte ranges');
    }
    const end = op.offset + op.delete_bytes;
    if (sha256(source.subarray(op.offset, end)) !== requireSha256(op.expected_sha256, 'operation.expected_sha256')) {
      throw new FileTransferError('PATCH_CONTEXT_MISMATCH', 'Deleted-byte hash does not match original source range');
    }
    const replacement = decodeStrictBase64(op.data_base64, 'operation.data_base64', MAX_FILE_BYTES);
    if (op.delete_bytes === 0 && replacement.length === 0) {
      throw new FileTransferError('INVALID_PATCH', 'Empty patch operation is not allowed');
    }
    const prefix = source.subarray(cursor, op.offset);
    outputBytes += prefix.length + replacement.length;
    if (outputBytes > MAX_FILE_BYTES) throw new FileTransferError('TOO_LARGE', 'Patch result exceeds maximum file size');
    chunks.push(prefix, replacement);
    cursor = end;
    lastOffset = op.offset;
  }
  const suffix = source.subarray(cursor);
  outputBytes += suffix.length;
  if (outputBytes > MAX_FILE_BYTES) throw new FileTransferError('TOO_LARGE', 'Patch result exceeds maximum file size');
  chunks.push(suffix);
  const result = Buffer.concat(chunks, outputBytes);
  if (sha256(result) !== expectedResultSha256) {
    throw new FileTransferError('RESULT_HASH_MISMATCH', 'Applied patch did not produce the declared result bytes');
  }
  return result;
}

export function reviewWindow(before: Buffer, after: Buffer): Record<string, unknown> {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const oldPart = before.subarray(start, oldEnd);
  const newPart = after.subarray(start, newEnd);
  const preview = (data: Buffer) => data.subarray(0, 1500).toString('utf8');
  return {
    offset: start,
    removedBytes: oldPart.length,
    insertedBytes: newPart.length,
    beforePreview: preview(oldPart),
    afterPreview: preview(newPart),
    previewTruncated: oldPart.length > 1500 || newPart.length > 1500,
    note: 'Common-prefix/suffix byte window; hashes bind the complete before/after bytes.'
  };
}
