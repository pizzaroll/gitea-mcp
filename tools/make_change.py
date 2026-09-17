#!/usr/bin/env python3
"""Make exact-byte MCP patch artifacts locally. No networking, Git, or third-party packages.
Adapted from the supplied gitea-file-actions 0.1.0 helper; retains gitea-byte-patch-v1.
"""
from __future__ import annotations
import argparse
import base64
import difflib
import hashlib
import json
import re
from pathlib import Path
from typing import Any
MAX_FILE = 4_000_000
MAX_UPLOAD = 6_000_000

def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result

def make_patch(before: bytes, after: bytes) -> dict[str, Any]:
    if len(before) > MAX_FILE or len(after) > MAX_FILE:
        raise ValueError("File exceeds 4,000,000 bytes")
    if before == after:
        raise ValueError("No change")
    old_lines, new_lines = before.splitlines(keepends=True), after.splitlines(keepends=True)
    old_offsets, new_offsets = [0], [0]
    for line in old_lines:
        old_offsets.append(old_offsets[-1] + len(line))
    for line in new_lines:
        new_offsets.append(new_offsets[-1] + len(line))
    operations: list[dict[str, Any]] = []
    for tag, a, b, c, d in difflib.SequenceMatcher(None, old_lines, new_lines, autojunk=True).get_opcodes():
        if tag == "equal":
            continue
        offset, end = old_offsets[a], old_offsets[b]
        replacement = after[new_offsets[c]:new_offsets[d]]
        # Refine each changed line window to exact bytes, keeping long-line edits small.
        prefix = 0
        removed = before[offset:end]
        while prefix < min(len(removed), len(replacement)) and removed[prefix] == replacement[prefix]:
            prefix += 1
        tail_old, tail_new = len(removed), len(replacement)
        while tail_old > prefix and tail_new > prefix and removed[tail_old-1] == replacement[tail_new-1]:
            tail_old -= 1
            tail_new -= 1
        offset, end = offset + prefix, offset + tail_old
        replacement = replacement[prefix:tail_new]
        operations.append({"offset":offset,"delete_bytes":end-offset,"expected_sha256":sha256(before[offset:end]),"data_base64":base64.b64encode(replacement).decode("ascii")})
    if len(operations) > 4096:
        # A single exact byte splice is a safe bounded fallback, not fuzzy matching.
        start = 0
        while start < min(len(before), len(after)) and before[start] == after[start]:
            start += 1
        end_before, end_after = len(before), len(after)
        while end_before > start and end_after > start and before[end_before-1] == after[end_after-1]:
            end_before -= 1
            end_after -= 1
        operations = [{"offset":start,"delete_bytes":end_before-start,"expected_sha256":sha256(before[start:end_before]),"data_base64":base64.b64encode(after[start:end_after]).decode("ascii")}]
    return {"format":"gitea-byte-patch-v1","source_sha256":sha256(before),"result_sha256":sha256(after),"operations":operations}

def build(source: Path, snapshot: Path, edited: Path, output: Path, message: str,
          mode: str = "byte_patch") -> tuple[Path, Path]:
    if source.stat().st_size > MAX_FILE or edited.stat().st_size > MAX_FILE or snapshot.stat().st_size > 64_000:
        raise ValueError("Input exceeds size limit")
    before, after = source.read_bytes(), edited.read_bytes()
    metadata = json.loads(snapshot.read_text(encoding="utf-8"), object_pairs_hook=unique_object)
    if not isinstance(metadata, dict):
        raise ValueError("Export metadata must be an object")
    snapshot_id = metadata.get("snapshot_id", "")
    if not isinstance(snapshot_id, str) or re.fullmatch(r"[a-f0-9]{64}", snapshot_id) is None:
        raise ValueError("Missing server-issued snapshot_id")
    if metadata.get("source_sha256") != sha256(before) or metadata.get("size_bytes") != len(before):
        raise ValueError("Downloaded bytes differ from export metadata")
    if before == after:
        raise ValueError("No change")
    if mode not in ("byte_patch", "replace"):
        raise ValueError("Invalid mode")
    if (not message.strip() or len(message) > 2048 or "Gitea-MCP-Change:" in message
            or any((ord(c) < 32 and c not in "\n\t") or ord(c) == 127 for c in message)):
        raise ValueError("Invalid or reserved commit message")
    artifact = (json.dumps(make_patch(before, after), separators=(",", ":")) + "\n").encode() if mode == "byte_patch" else after
    if len(artifact) > MAX_UPLOAD:
        raise ValueError("Patch exceeds limit; use --mode replace")
    artifact_path = Path(str(output) + (".patch.json" if mode == "byte_patch" else ".replacement.bin"))
    metadata_path = Path(str(output) + ".metadata.json")
    if artifact_path.exists() or metadata_path.exists():
        raise FileExistsError("Output already exists; select a new output prefix")
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    with artifact_path.open("xb") as stream:
        stream.write(artifact)
    result = {
        "artifact_path": str(artifact_path.resolve()), "artifact_size_bytes": len(artifact),
        "prepare_arguments": {"snapshot_id": snapshot_id, "mode": mode,
            "expected_source_sha256": sha256(before), "upload_sha256": sha256(artifact),
            "result_sha256": sha256(after), "message": message},
        "file_binding": "Pass artifact_path as the native MCP top-level file parameter through the host's file binding. Do not fabricate file IDs or download URLs, or paste artifact bytes into JSON arguments."
    }
    with metadata_path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(result, indent=2) + "\n")
    return artifact_path, metadata_path

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "snapshot", "edited", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--message", required=True)
    parser.add_argument("--mode", choices=["byte_patch", "replace"], default="byte_patch")
    args = parser.parse_args()
    try:
        artifact, metadata = build(args.source, args.snapshot, args.edited, args.output, args.message, args.mode)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, f"Error: {error}\n")
    print(json.dumps({"artifact": str(artifact), "metadata": str(metadata)}))

if __name__ == "__main__":
    main()
