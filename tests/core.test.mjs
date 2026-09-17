import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyBytePatch, base64, MAX_FILE, repoPath, refName, sha256, strictJSON } from '../build/file-transfer/core.js';
import { publicAddress, uploadURL, downloadUpload } from '../build/file-transfer/transfer.js';
import { splicePatch } from './helpers.mjs';
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/byte-patch-fixtures.json', import.meta.url)));
for (const fixture of fixtures) test(`ported Go/Python fixture: ${fixture.name}`, () => {
  assert.deepEqual(applyBytePatch(Buffer.from(fixture.before, 'base64'), Buffer.from(JSON.stringify(fixture.patch)),
    fixture.patch.result_sha256), Buffer.from(fixture.after, 'base64'));
});
for (const [name, edit] of [
  ['negative offset', p => p.operations[0].offset = -1],
  ['fractional offset', p => p.operations[0].offset = 0.5],
  ['unsafe integer', p => p.operations[0].offset = 2 ** 53],
  ['out of bounds', p => p.operations[0].delete_bytes = 100],
  ['unknown field', p => p.extra = 1],
  ['unknown operation field', p => p.operations[0].extra = 1],
  ['wrong source hash', p => p.source_sha256 = '0'.repeat(64)],
  ['wrong result hash', p => p.result_sha256 = '0'.repeat(64)],
  ['wrong deleted bytes', p => p.operations[0].expected_sha256 = '0'.repeat(64)],
  ['invalid base64', p => p.operations[0].data_base64 = 'QQ='],
  ['noncanonical base64', p => p.operations[0].data_base64 = 'QR=='],
  ['overlap', p => p.operations.push({ ...p.operations[0] })],
  ['no operations', p => p.operations = []],
  ['too many operations', p => p.operations = Array(4097).fill(p.operations[0])],
]) test(`reject patch: ${name}`, () => {
  const before = Buffer.from('abc'), after = Buffer.from('aXc');
  const patch = JSON.parse(splicePatch(before, after)); edit(patch);
  assert.throws(() => applyBytePatch(before, Buffer.from(JSON.stringify(patch)), sha256(after)));
});
test('bounded 4 MB canonical base64 does not overflow the regexp stack', () => {
  const bytes = Buffer.alloc(MAX_FILE, 127); assert.deepEqual(base64(bytes.toString('base64')), bytes);
});
test('strict parser rejects duplicate decoded keys, invalid UTF-8, depth and trailing data', () => {
  for (const bytes of [Buffer.from('{"key":1,"\\u006bey":2}'), Buffer.from([0xff]),
    Buffer.from('['.repeat(66) + '0' + ']'.repeat(66)), Buffer.from('{}extra'), Buffer.from('{"a":1,}')]) {
    assert.throws(() => strictJSON(bytes), { code: 'INVALID_JSON' });
  }
});
test('repo paths and refs reject traversal, encoded traversal and internals', () => {
  for (const p of ['../x', '/x', 'a//b', 'a/../b', 'C:\\x', 'a\\b', '.git/config', 'a/.GiT/config',
    'a/%2e%2e/b', 'x\x00', 'x/./y', 'name.', '//share/x']) assert.throws(() => repoPath(p));
  for (const r of ['../main', 'main~1', 'main^{tree}', 'refs//heads/main', 'bad.lock', 'a@{0}']) assert.throws(() => refName(r));
  assert.equal(repoPath('src/.config/name.ts'), 'src/.config/name.ts'); assert.equal(refName('feat/file-transfer'), 'feat/file-transfer');
});
test('upload URL policy rejects alternate schemes, credentials, IPs, ports and unapproved hosts', () => {
  for (const u of ['http://files.oaiusercontent.com/a', 'file:///etc/passwd', 'https://127.0.0.1/x',
    'https://files.oaiusercontent.com.evil.test/a', 'https://user:pass@files.oaiusercontent.com/x',
    'https://files.oaiusercontent.com:444/x', 'https://files.oaiusercontent.com./x', 'https://files.oaiusercontent.com/a#x']) {
    assert.throws(() => uploadURL(u, ['files.oaiusercontent.com']));
  }
  assert.equal(uploadURL('https://files.oaiusercontent.com/x?sig=opaque', ['files.oaiusercontent.com']).hostname, 'files.oaiusercontent.com');
});
test('all special-use and IPv4-mapped DNS addresses fail closed', () => {
  for (const ip of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '172.16.1.1', '192.168.1.1',
    '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1',
    'fc00::1', 'fe80::1', '64:ff9b::7f00:1', '2001:db8::1', '2002:7f00:1::']) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true); assert.equal(publicAddress('2606:4700:4700::1111'), true);
});
test('download rejects a DNS-resolved private address before opening a connection', async () => {
  await assert.rejects(downloadUpload({ file_id: 'file_test', download_url: 'https://localhost/source' }, ['localhost']),
    { code: 'UNSAFE_UPLOAD_ADDRESS' });
});
