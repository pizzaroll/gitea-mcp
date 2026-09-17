export const fileTransferToolDefinitions = [
  {
    name: 'export_source_file',
    description: 'Export exact repository file bytes as an MCP binary resource, pinned to a resolved immutable commit with SHA-256 metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string', description: 'Configured Gitea instance identifier' },
        owner: { type: 'string', description: 'Repository owner' },
        repository: { type: 'string', description: 'Repository name' },
        path: { type: 'string', description: 'Repository-relative POSIX file path' },
        ref: { type: 'string', description: 'Branch, tag, or exact commit SHA to resolve' }
      },
      required: ['instanceId', 'owner', 'repository', 'path', 'ref'],
      additionalProperties: false
    }
  },
  {
    name: 'prepare_file_change',
    description: 'Verify and stage an exact byte patch or complete replacement without committing. Hash guards are mandatory.',
    inputSchema: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
        owner: { type: 'string' },
        repository: { type: 'string' },
        branch: { type: 'string', description: 'Target branch used for stale-write protection.' },
        baseCommitSha: { type: 'string' },
        path: { type: 'string' },
        expectedSourceSha256: { type: 'string' },
        mode: { type: 'string', enum: ['patch', 'replace'] },
        artifactBase64: { type: 'string', description: 'Base64 bytes of the small patch artifact or replacement file.' },
        uploadSha256: { type: 'string' },
        resultSha256: { type: 'string' },
        message: { type: 'string', description: 'Commit message retained with the staged change.' }
      },
      required: ['instanceId', 'owner', 'repository', 'branch', 'baseCommitSha', 'path', 'expectedSourceSha256', 'mode', 'artifactBase64', 'uploadSha256', 'resultSha256', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'get_file_change',
    description: 'Review an exact staged file change, including old/new hashes, byte-change window, base commit and publication state.',
    inputSchema: {
      type: 'object',
      properties: { changeId: { type: 'string' } },
      required: ['changeId'],
      additionalProperties: false
    }
  },
  {
    name: 'commit_file_change',
    description: 'Explicitly publish a staged file change after revalidating branch head, source bytes and review hash.',
    inputSchema: {
      type: 'object',
      properties: {
        changeId: { type: 'string' },
        reviewSha256: { type: 'string' }
      },
      required: ['changeId', 'reviewSha256'],
      additionalProperties: false
    }
  }
];
