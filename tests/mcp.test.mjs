import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../build/config/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('actual stdio MCP preserves legacy tools and advertises native file bindings', async () => {
  const client = new Client({ name: 'file-transfer-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: ['build/index.js'], stderr: 'pipe',
    env: { ...process.env, FILE_TRANSFER_PUBLIC_URL: '', FILE_TRANSFER_STATE_DIR: '', NODE_ENV: 'production',
      GITEA_INSTANCES: JSON.stringify([{ id: 'test', name: 'Test', baseUrl: 'http://127.0.0.1:1', token: 'test-only-not-real' }]) } });
  let stderr = ''; transport.stderr?.on('data', b => stderr += b.toString());
  try {
    await client.connect(transport);
    const result = await client.listTools();
    for (const name of ['create_repository', 'upload_files', 'sync_project', 'sync_update',
      'export_source_file', 'prepare_file_change', 'get_file_change', 'commit_file_change']) {
      assert.ok(result.tools.some(t => t.name === name), name);
    }
    const prepare = result.tools.find(t => t.name === 'prepare_file_change');
    assert.deepEqual(prepare._meta['openai/fileParams'], ['file']);
    assert.deepEqual(Object.keys(prepare.inputSchema.properties.file.properties).sort(),
      ['download_url', 'file_id', 'file_name', 'mime_type']);
    assert.deepEqual(prepare.inputSchema.properties.file.required, ['download_url', 'file_id']);
    const commit = result.tools.find(t => t.name === 'commit_file_change');
    assert.equal(commit.annotations.destructiveHint, true); assert.equal(commit.annotations.readOnlyHint, false);
    const response = await client.callTool({ name: 'get_file_change', arguments: { change_id: 'a'.repeat(64) } });
    assert.equal(response.isError, true); assert.equal(JSON.parse(response.content[0].text).code, 'FILE_TRANSFER_NOT_CONFIGURED');
    assert.ok(!stderr.includes('test-only-not-real'));
  } finally { await client.close(); }
});
test('configuration honors the environment and fails closed without exposing malformed secrets', () => {
  const old = process.env.GITEA_INSTANCES;
  try {
    process.env.GITEA_INSTANCES = JSON.stringify([{ id: 'configured', name: 'Configured', baseUrl: 'https://gitea.example.test', token: 'explicit-test-token' }]);
    assert.equal(loadConfig().gitea.instances[0].id, 'configured');
    assert.equal(loadConfig().gitea.instances[0].token, 'explicit-test-token');
    process.env.GITEA_INSTANCES = '{secret:do-not-log}';
    assert.throws(() => loadConfig(), error => { assert.ok(!error.message.includes('do-not-log')); return true; });
    process.env.GITEA_INSTANCES = '[]'; assert.throws(() => loadConfig());
  } finally { if (old === undefined) delete process.env.GITEA_INSTANCES; else process.env.GITEA_INSTANCES = old; }
});
test('single-instance configuration reads an existing mounted token file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gitea-mcp-token-'));
  const tokenFile = join(directory, 'token'); writeFileSync(tokenFile, 'mounted-test-token\n');
  const saved = Object.fromEntries(['GITEA_INSTANCES', 'GITEA_HOST', 'GITEA_ACCESS_TOKEN_FILE'].map(key => [key, process.env[key]]));
  try {
    delete process.env.GITEA_INSTANCES;
    process.env.GITEA_HOST = 'https://gitea.example.test'; process.env.GITEA_ACCESS_TOKEN_FILE = tokenFile;
    const instance = loadConfig().gitea.instances[0];
    assert.equal(instance.id, 'main'); assert.equal(instance.baseUrl, 'https://gitea.example.test');
    assert.equal(instance.token, 'mounted-test-token');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
