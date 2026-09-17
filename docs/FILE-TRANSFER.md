# Exact file transfer and staged editing

The MCP exposes four tools for large-file editing without placing the full source file in tool arguments:

1. `export_source_file` resolves a branch/ref to an immutable commit, reads the exact repository bytes, verifies Gitea blob metadata, calculates SHA-256, and returns the source as an MCP binary resource.
2. `prepare_file_change` re-reads the authoritative source, validates `expectedSourceSha256`, validates the uploaded artifact hash, applies either an exact-byte patch or complete replacement, validates `resultSha256`, and stages the result in memory. It does not publish.
3. `get_file_change` returns the base commit/blob, old/new SHA-256 values, review hash, change window and publication state.
4. `commit_file_change` is the explicit publication step. It requires the staged review hash, verifies that branch HEAD still equals the staged base commit, verifies the source blob and SHA-256 again, writes with Gitea's file-blob `sha` guard, and verifies the final bytes at the returned commit SHA.

## Patch format

Patches use `gitea-byte-patch-v1`. Offsets and delete lengths refer to the original source bytes, never to an intermediate result. Operations must be ordered and non-overlapping.

```json
{
  "format": "gitea-byte-patch-v1",
  "source_sha256": "<64 lowercase hex>",
  "result_sha256": "<64 lowercase hex>",
  "operations": [
    {
      "offset": 123,
      "delete_bytes": 4,
      "expected_sha256": "<sha256 of exactly the deleted original bytes>",
      "data_base64": "<replacement bytes>"
    }
  ]
}
```

`prepare_file_change` accepts the patch/replacement bytes in `artifactBase64`. The preferred large-source workflow is therefore: export the real source resource, edit it locally, generate a small exact-byte patch, base64-encode only that patch, then stage/review/publish.

## Security and concurrency

Repository paths must be normalized relative POSIX paths. Absolute paths, traversal, backslashes, `.git` path segments, directories, symlinks/submodules and Git LFS pointers are rejected. The MCP never exposes the configured Gitea token and does not provide shell execution or arbitrary server-filesystem access.

Gitea's contents update API accepts the existing file blob SHA but does not expose an atomic expected-branch-HEAD compare-and-swap field. The MCP therefore checks branch HEAD immediately before publication and records whether the returned commit parent still matched the staged base. A race after the precheck cannot be made fully atomic through this API; that limitation is returned in the publication receipt rather than concealed.

Staged changes are intentionally process-local and expire after one hour. A server restart invalidates uncommitted staging records; re-export and restage after a restart.
