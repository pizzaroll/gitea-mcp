import { describe, expect, it } from 'vitest';
import { applyBytePatch, sha256, validateRepoPath } from '../src/tools/file-transfer.js';

describe('file transfer exact-byte patching', () => {
  it('edits a ~123 KB file with a small deterministic patch', () => {
    const source = Buffer.concat([
      Buffer.alloc(60_000, 0x41),
      Buffer.from('TARGET\r\n'),
      Buffer.alloc(63_000, 0x42)
    ]);
    const deleted = Buffer.from('TARGET\r\n');
    const replacement = Buffer.from('REPLACED\r\n');
    const offset = 60_000;
    const expected = Buffer.concat([
      source.subarray(0, offset),
      replacement,
      source.subarray(offset + deleted.length)
    ]);
    const artifact = Buffer.from(JSON.stringify({
      format: 'gitea-byte-patch-v1',
      source_sha256: sha256(source),
      result_sha256: sha256(expected),
      operations: [{
        offset,
        delete_bytes: deleted.length,
        expected_sha256: sha256(deleted),
        data_base64: replacement.toString('base64')
      }]
    }));

    expect(source.length).toBe(123_008);
    expect(artifact.length).toBeLessThan(600);
    expect(applyBytePatch(source, artifact, sha256(expected))).toEqual(expected);
  });

  it('rejects overlapping operations and mismatched context', () => {
    const source = Buffer.from('0123456789abcdef');
    const bogusResult = sha256(Buffer.from('result'));
    const overlapping = Buffer.from(JSON.stringify({
      format: 'gitea-byte-patch-v1',
      source_sha256: sha256(source),
      result_sha256: bogusResult,
      operations: [
        { offset: 2, delete_bytes: 4, expected_sha256: sha256(source.subarray(2, 6)), data_base64: 'QQ==' },
        { offset: 4, delete_bytes: 2, expected_sha256: sha256(source.subarray(4, 6)), data_base64: 'Qg==' }
      ]
    }));
    expect(() => applyBytePatch(source, overlapping, bogusResult)).toThrow(/non-overlapping/);
  });

  it('rejects traversal, absolute, backslash and .git paths', () => {
    expect(validateRepoPath('src/index.ts')).toBe('src/index.ts');
    for (const candidate of ['../secret', '/etc/passwd', 'a/../b', '.git/config', 'src\\index.ts', 'C:/temp/x']) {
      expect(() => validateRepoPath(candidate)).toThrow();
    }
  });
});
