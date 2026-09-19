# Native file transfer in the existing Gitea MCP

One integration: `@GIT`. The four file tools join the existing tool list and use
its configured Gitea instances and credentials. There is no additional GPT Action,
MCP registration, shell tool, Git checkout, or separately deployed Go service.
The provided `gitea-file-actions-0.1.0-source.zip` supplied the exact-byte patch
format, security model, cross-language fixtures and Python helper implementation
material; the runtime has been ported to TypeScript rather than vendored as a sidecar.

## Transport contract and its deployment acceptance gate

`prepare_file_change` declares `_meta["openai/fileParams"] = ["file"]`. The native
ChatGPT host expands that top-level input into `{download_url, file_id,
mime_type?, file_name?}`. All four properties are declared; only `download_url`
and `file_id` are required. Pass a real uploaded/local artifact using the host's
file binding. Do not fabricate IDs, signed URLs, or pass a server/client filesystem
path as a download URL. GPT Actions' `openaiFileIdRefs` is **not** the MCP contract.

Exports and reviews return MCP `resource_link` content with real, short-lived
HTTPS URLs and matching file metadata in `structuredContent`. These URLs serve
raw bytes, not JSON-encoded source and not paths on the MCP host. No made-up
OpenAI `file_id` is returned. A host that downloads resource links can place these
bytes in its execution environment; a generic MCP client can fetch the URL.

**Automatic mounting of a resource link into a particular ChatGPT deployment is
not guaranteed by MCP itself.** Verify this using the existing `@GIT` gateway and
ChatGPT client after deployment. The gateway must preserve tool `_meta`, output
schemas and `resource_link` results. If its host cannot ingest the returned HTTPS
file into the execution environment, stop: that host/gateway capability is still
missing. A displayed link alone does not prove the complete ChatGPT acceptance
workflow. Do not claim end-to-end ChatGPT acceptance based only on unit tests or
silently introduce a second permanent integration to work around it.

References:
- Native file inputs: https://developers.openai.com/plugins/reference#define-file-inputs
- MCP resource links: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Gitea API: https://docs.gitea.com/api/1.24/

## Configuration and deployment

The executable defaults to stdio MCP and also supports stateless Streamable HTTP
at `/mcp` with `MCP_TRANSPORT=http`. In HTTP deployments, set
`FILE_TRANSFER_SHARED_HTTP=true` to serve expiring file capabilities from the
same listener and public origin. This is still one MCP process and one `@GIT`
integration.

Use Node 22 (CI validation runtime), install with `npm ci`, and build with
`npm run build`. The implementation adds no npm runtime dependencies. The Python
helper uses Python 3.10+ and its standard library only.

```sh
# Install a private persistent LOCAL directory owned by the MCP service UID.
install -d -m 700 /var/lib/gitea-mcp/file-changes

# Load the real token from your deployment's secret manager, not source control.
export GITEA_INSTANCES='[{"id":"main","name":"Gitea","baseUrl":"https://gitea.example.com","token":"REPLACE_FROM_SECRET_MANAGER"}]'
export FILE_TRANSFER_STATE_DIR=/var/lib/gitea-mcp/file-changes
export FILE_TRANSFER_PUBLIC_URL=https://git-tools.example.com/file-transfer
export FILE_TRANSFER_HOST=127.0.0.1
export FILE_TRANSFER_PORT=8081
# Exact runtime upload hosts only; no wildcards. Add the hosts actually emitted
# by your ChatGPT file binding, after verifying they belong to the file provider.
export FILE_TRANSFER_UPLOAD_HOSTS=files.oaiusercontent.com
npm start
```

For a tunnel deployment on one port:

```sh
export MCP_TRANSPORT=http
export MCP_HOST=0.0.0.0
export MCP_PORT=8080
export FILE_TRANSFER_SHARED_HTTP=true
export FILE_TRANSFER_PUBLIC_URL=https://git-tools.example.com/file-transfer
```

`GITEA_INSTANCES` remains the general multi-instance configuration. A single
instance may instead use `GITEA_HOST` plus `GITEA_ACCESS_TOKEN_FILE`; the latter
is read directly from the mounted secret and is never copied into an environment
variable.

For a reverse proxy in another container, bind the artifact listener to
`0.0.0.0` on a private container network instead of exposing it directly publicly.
Example nginx location (same public origin as the existing gateway is recommended):

```nginx
location /file-transfer/ {
    access_log off;  # The opaque URL is a bearer capability; never log it.
    proxy_pass http://127.0.0.1:8081;
    proxy_buffering off;
    proxy_cache off;
    proxy_set_header Connection "";
}
```

The listener is initialized on the first file-tool call. File tools return
`FILE_TRANSFER_NOT_CONFIGURED` until both the public URL and state directory are
set; existing repository tools do not require file-transfer configuration.
TLS is terminated at the proxy. Do not require a Gitea token or browser cookie to
download these capability URLs. Protect the MCP gateway itself with its existing
authentication. Do not cache downloads or include their URLs in analytics,
access logs, referrers, tickets, or permanent documentation.

The original configuration loader contained an embedded credential and ignored
the environment. That fallback and secret logging have been removed. **Rotate
that previously embedded Gitea token before deployment: removing it from the new
revision does not remove it from Git history or old artifacts.** Valid
`GITEA_INSTANCES` is now mandatory. MCP stdout is now protocol-only; logs use stderr.

## Operations

All paths identify **existing regular files** inside a repository. This initial
workflow does not add/delete/rename files, edit symlinks or submodules, resolve
LFS content, or create branches. Create a disposable/feature branch with the
existing repository facilities first. The existing legacy tools are retained;
the new guardrails do not retroactively harden those older write/local-sync tools.

### 1. `export_source_file`

Inputs: `instanceId`, `owner`, `repository`, `path`, `ref`, optional `branch`.
Resolve `ref` to an immutable commit, walk its trees and verify the native blob
hash. A branch name may be used as `ref`. For an exact commit plus a publication
target, provide `branch` and require its current HEAD to equal that commit.
Exports of detached commits/tags without a matching branch are read-only snapshots.

Returns repository coordinates, requested ref, resolved/base commit SHA, target
branch or null, native blob SHA, source SHA-256, exact size, opaque `snapshot_id`,
snapshot expiry and `file` download metadata. Download links last five minutes;
snapshots last one hour. Re-export to renew an expired source download.

### 2. Local edit and artifact creation

Download the source bytes and save the export's `structuredContent` as
`export.json` in ChatGPT's local environment. Edit a separate copy without
unintentional encoding, BOM or newline normalization.

```sh
python3 tools/make_change.py \
  --source source.bin --snapshot export.json --edited edited.ts \
  --output change --message 'Fix bounded lifecycle dispatch'
```

The helper writes `change.patch.json` and `change.metadata.json`; the latter
contains `prepare_arguments` and the local artifact path. It does not upload,
make repository changes or fabricate file handles. Use `--mode replace` for a
complete binary/text replacement when more appropriate. Existing output files
are never overwritten. Both multiline and long-single-line small edits generate
small exact-byte patches.

### 3. `prepare_file_change`

Inputs: `snapshot_id`, native `file`, `mode` (`byte_patch` or `replace`),
`expected_source_sha256`, `upload_sha256`, `result_sha256`, `message`.

Re-read authoritative source at the base commit; verify branch state, expected
source, downloaded upload bytes, exact patch ranges/context and final result.
Verify branch state again after downloading/applying the upload. Stage privately
without a Gitea write. No-op results are rejected.

Returns review metadata, `change_id`, `review_sha256`, old/new hashes, byte-window
diff summary, bounded previews and full `before_file`/`after_file` downloads.
Previews are not a minimal unified diff and may be truncated or decode binary
bytes imperfectly. The complete downloads and hashes are authoritative. The
review binds the target, base state, hashes, mode and commit message; its
`publication_message` includes a deterministic `Gitea-MCP-Change:` audit trailer.

### 4. `get_file_change`

Input: `change_id`. Re-check stored byte/review integrity and upstream read
permission, then return the review, refreshed before/after download URLs and
publication state. Review never writes to Gitea. Stages/receipts are retained for
24 hours from preparation, not indefinitely. Expired state is collected on writes.

### 5. `commit_file_change`

Inputs: `change_id`, exact `review_sha256` from the inspected review. This is the
only new tool that writes to Gitea and is marked destructive, non-read-only and
idempotent. Invoke only after explicit approval of the proposed change.

Revalidate the review, stored bytes, branch HEAD and authoritative source, then
persist `publishing` intent before the single PUT. Supply the base native blob
SHA to Gitea's file update API. Never force-push, perform a merge, or automatically
retry a write. Verify returned commit parents, file content at that exact SHA,
result SHA-256/native blob hash and observed branch HEAD. Return the actual commit
SHA, repository/branch/path, result SHA-256 and status.

Publication status meanings:

| Status | Meaning/action |
| --- | --- |
| `staged` | No write has been attempted. Review and explicitly publish. |
| `publishing` | Durable write intent exists; a process may have crashed in-flight. Never resend the PUT automatically. |
| `published` | Returned commit, expected single parent, result bytes and observed HEAD verified. |
| `published_branch_race` | Result bytes verified but the returned commit has an unexpected parent. Publication already happened; inspect it. No automatic rollback. |
| `published_branch_moved` | Result/parent verified, but HEAD advanced again before verification completed. Inspect current branch. |
| `publication_unknown` | A write or its verification failed/was interrupted. A known commit SHA is retained when available. Do not assume nothing was published. |

Repeated commit calls for any non-staged state return its receipt without a new
PUT, including after restart. Receipts bind `result_sha256` to the reviewed target;
that hash is **not proof of publication** unless the status says verification
succeeded. There is deliberately no automatic recovery/retry/force-reset tool.
For uncertain outcomes, an operator must inspect branch history, the unique
commit-message trailer, parents, target bytes and hashes. Reconcile manually;
do not delete the state record and blindly retry the old edit.

## Concurrency limitation: not atomic branch-HEAD CAS

The Gitea contents PUT used here guards the native **file blob SHA**, not an
atomic expected branch HEAD. HEAD/source checks narrow the race window but do
not close it. An unrelated branch commit between preflight and PUT may cause
Gitea to publish our file update on top of that new parent. We detect and report
that unexpected parent after publication; we cannot honestly promise to reject
it before it happens using this API. Concurrent changes to the target blob are
passed to Gitea's native SHA guard rather than silently overwritten.

Use a dedicated feature branch with one authorized writer during publication.
For a strict atomic branch compare-and-swap requirement, a separately verified
server-side conditional-ref operation would be required. It is not provided or
claimed by this implementation. Branch protections and token permissions remain
authoritative. Preflight stale errors include expected and observed HEAD/source
identities so the edit can be rebuilt from a fresh export.

## Exact patch and security model

`gitea-byte-patch-v1` retains the provided package's byte-offset semantics:

```json
{
  "format": "gitea-byte-patch-v1",
  "source_sha256": "64 lowercase hexadecimal characters",
  "result_sha256": "64 lowercase hexadecimal characters",
  "operations": [{
    "offset": 100,
    "delete_bytes": 4,
    "expected_sha256": "SHA-256 of the four original bytes",
    "data_base64": "bmV3"
  }]
}
```

Offsets always address the original file; operations are strictly ordered,
non-overlapping safe integers, with 1–4096 operations. Unknown fields, duplicate
JSON keys, malformed UTF-8, excessive nesting, noncanonical base64, invalid
ranges and all hash mismatches fail closed. Binary bytes, CRLF/LF and BOMs are
preserved. No fuzzy matching or shell execution is used.

Limits: 4,000,000 bytes per source/result; 6,000,000 per uploaded artifact;
64,000,000 bytes/128 records in the private state directory; 32,000,000 bytes/64
short-lived downloadable objects in memory. Uploads have bounded DNS/network
lifetimes, exact host allowlisting, public-address checks across every DNS
answer, pinned-IP TLS dialing, no redirects, no implicit proxy, no Gitea headers,
no decompression and bounded response size. Administrators should additionally
restrict outbound traffic to their approved Gitea/file-provider endpoints.

Repository paths reject traversal, absolute/Windows paths, encoded path tricks,
`.git` components and unsafe characters. Immutable tree modes reject symlinks at
all components and gitlinks. State files are opaque-ID names, private 0600,
no-follow regular files; directories are private 0700, owned and symlink-free.
Writes are atomic and fsynced. No credential or uploaded signed URL is persisted
in a state record. A credential/instance fingerprint binds state to the existing
configuration; rotation invalidates old staged operations. Download capabilities
already issued can remain usable for their five-minute lifetime after revocation.

**Trust boundary:** the existing stdio server is a single authenticated principal
(or intentionally shared service-account trust domain), not a multi-user OAuth
server. A gateway must not expose one shared instance-token process to mutually
untrusted users. Use separately authorized worker/state directories per principal
when necessary; no unverified client metadata is treated as authorization.

Run one process/replica per private local state directory. `.writer-lock` excludes
other processes. After a crash the lock deliberately remains: confirm the old
process is stopped before removing that lock directory. Never remove it while a
writer might still run, and never share this storage over NFS. Inspect any
`publishing`/`publication_unknown` records before proceeding. Private source
records require the same backup/access controls as the repository itself.

## Validation and deployment acceptance

```sh
npm ci
npm run type-check
npm test
python3 -m unittest discover -s tools -p 'test_*.py' -v
```

The native Node suite checks patch/parser/path/SSRF policy, private storage,
capability downloads, legacy plus native MCP tool discovery, hash guards,
publication idempotence/crash behavior, authorization changes and Gitea adapter
requests. The Python suite includes randomized binary edits and cross-language
fixtures from the supplied package. CI additionally starts disposable Gitea
1.24.6 and exercises the real contents API, parent receipts, exact-SHA reads and
stale branch rejection without using production credentials or Git CLI.

The large-file regression exports 123,517 bytes through the real HTTP artifact
handler, stages a 374-byte patch, verifies no write before explicit publication,
and verifies the resulting source SHA-256. Unit tests use a controlled repository
adapter; the dedicated CI integration also uses a real disposable Gitea.

**Final deployed `@GIT` smoke test (must be run on the actual host):** create a
disposable feature branch; export a >120 KB source file; confirm actual bytes are
present in ChatGPT's execution environment; edit locally; generate the helper
patch; pass it using the native `file` binding; confirm staging did not advance
HEAD; review both exact artifacts and hash; explicitly commit; record the real
commit SHA; re-export that exact SHA and verify the final SHA-256. Repeat with a
stale snapshot to confirm safe rejection. Local/CI tests do not substitute for
this host-specific file-ingestion and upload-binding acceptance test.
