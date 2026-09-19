import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  const port = address.port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(port, child) {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`HTTP server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('HTTP server did not become healthy');
}

test('stateless Streamable HTTP endpoint preserves the complete tool surface', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['build/index.js'], { stdio: ['ignore', 'ignore', 'pipe'], env: {
    ...process.env, MCP_TRANSPORT: 'http', MCP_HOST: '127.0.0.1', MCP_PORT: String(port),
    FILE_TRANSFER_PUBLIC_URL: '', FILE_TRANSFER_STATE_DIR: '', NODE_ENV: 'production',
    GITEA_INSTANCES: JSON.stringify([{ id: 'test', name: 'Test', baseUrl: 'http://127.0.0.1:1', token: 'test-only-not-real' }]),
  }});
  let stderr = ''; child.stderr.on('data', bytes => stderr += bytes.toString());
  const client = new Client({ name: 'http-regression', version: '1.0.0' });
  try {
    await waitForHealth(port, child);
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200); assert.equal(await root.text(), 'I am running\n');
    const get = await fetch(`http://127.0.0.1:${port}/mcp`);
    assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const result = await client.listTools();
    for (const name of ['create_repository', 'upload_files', 'sync_project', 'sync_update',
      'export_source_file', 'prepare_file_change', 'get_file_change', 'commit_file_change']) {
      assert.ok(result.tools.some(tool => tool.name === name), name);
    }
    assert.ok(!stderr.includes('test-only-not-real'));
  } finally {
    await client.close().catch(() => {});
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
});

