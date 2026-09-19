"""Offline regression tests adapted from the supplied standalone implementation."""
import base64
import json
import random
import tempfile
import unittest
from pathlib import Path
import make_change as tool


def apply(before, patch):
    cursor, parts = 0, []
    for op in patch['operations']:
        start, count = op['offset'], op['delete_bytes']
        assert start >= cursor
        assert tool.sha256(before[start:start + count]) == op['expected_sha256']
        parts.extend([before[cursor:start], base64.b64decode(op['data_base64'], validate=True)])
        cursor = start + count
    result = b''.join(parts) + before[cursor:]
    assert tool.sha256(result) == patch['result_sha256']
    return result


class HelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.before, self.after = b'original\r\n', b'edited\x00\r\n'
        self.source, self.snapshot, self.edited = (self.root / name for name in ('source.bin', 'export.json', 'edited.bin'))
        self.source.write_bytes(self.before)
        self.edited.write_bytes(self.after)
        self.snapshot.write_text(json.dumps({'snapshot_id': 'a' * 64, 'source_sha256': tool.sha256(self.before), 'size_bytes': len(self.before)}))

    def test_random_binary_bom_unicode_crlf_edits(self):
        rng = random.Random(20260917)
        pairs = [(b'', b'\x00'), (b'abc', b''), (b'\xef\xbb\xbfalpha\r\n', b'\xef\xbb\xbfBETA\r\n'),
                 ('\u03b1\u03b2'.encode(), '\u03b1\u03a9'.encode())]
        for _ in range(300):
            before = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 600)))
            start = rng.randrange(len(before) + 1)
            end = rng.randrange(start, len(before) + 1)
            pairs.append((before, before[:start] + b'\x00changed\xff' + before[end:]))
        for before, after in pairs:
            self.assertEqual(apply(before, tool.make_patch(before, after)), after)

    def test_large_file_and_single_long_line_small_patches(self):
        for before in [b'// unchanged line\r\n' * 6500 + b'process(frame);\r\n', b'x' * 123000 + b'process(frame);']:
            after = before.replace(b'process(frame);', b'dispatch_bounded(frame);')
            patch = tool.make_patch(before, after)
            self.assertLess(len(json.dumps(patch)), 1000)
            self.assertEqual(apply(before, patch), after)

    def test_both_modes_hashes_and_native_file_binding(self):
        for mode in ('byte_patch', 'replace'):
            artifact, metadata = tool.build(self.source, self.snapshot, self.edited, self.root / mode, 'Fix dispatch', mode)
            data = json.loads(metadata.read_text())
            args = data['prepare_arguments']
            self.assertEqual(args['upload_sha256'], tool.sha256(artifact.read_bytes()))
            self.assertEqual(args['expected_source_sha256'], tool.sha256(self.before))
            self.assertEqual(args['result_sha256'], tool.sha256(self.after))
            self.assertEqual(args['snapshot_id'], 'a' * 64)
            self.assertNotIn('file', args)
            self.assertIn('Do not fabricate', data['file_binding'])
            if mode == 'byte_patch':
                self.assertEqual(apply(self.before, json.loads(artifact.read_bytes())), self.after)
            else:
                self.assertEqual(artifact.read_bytes(), self.after)
            with self.assertRaises(FileExistsError):
                tool.build(self.source, self.snapshot, self.edited, self.root / mode, 'No overwrite', mode)

    def test_duplicate_export_keys_rejected(self):
        self.snapshot.write_text('{"snapshot_id":"one","snapshot_id":"two"}')
        with self.assertRaises(ValueError):
            tool.build(self.source, self.snapshot, self.edited, self.root / 'out', 'Fix')

    def test_download_hash_mismatch(self):
        self.source.write_bytes(b'wrong source')
        with self.assertRaises(ValueError):
            tool.build(self.source, self.snapshot, self.edited, self.root / 'out', 'Fix')

    def test_invalid_messages_modes_and_size(self):
        for message in ['', ' ', 'x' * 2049, 'Gitea-MCP-Change: fake', 'bad\x00message']:
            with self.assertRaises(ValueError):
                tool.build(self.source, self.snapshot, self.edited, self.root / 'out', message)
        with self.assertRaises(ValueError):
            tool.build(self.source, self.snapshot, self.edited, self.root / 'out', 'Fix', 'fuzzy')
        with self.assertRaises(ValueError):
            tool.make_patch(b'', b'x' * (tool.MAX_FILE + 1))
        with self.assertRaises(ValueError):
            tool.make_patch(b'unchanged', b'unchanged')

    def test_shared_go_typescript_fixture_contract(self):
        fixtures = json.loads((Path(__file__).parent.parent / 'tests/fixtures/byte-patch-fixtures.json').read_text())
        for fixture in fixtures:
            before, after = base64.b64decode(fixture['before']), base64.b64decode(fixture['after'])
            self.assertEqual(apply(before, fixture['patch']), after)
            self.assertEqual(apply(before, tool.make_patch(before, after)), after)


if __name__ == '__main__':
    unittest.main()
