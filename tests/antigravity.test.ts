import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildDirectMcpServer } from '../src/mcp/server';
import { loadLocalVaultConfig } from '../src/vault-engine';
import { runAgyPreInvocation } from '../src/hook/agy-pre-invocation';

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

describe('Antigravity Ollama-free direct vault MCP & PreInvocation hook', () => {
  let vaultDir: string;
  let client: Client | undefined;

  beforeEach(async () => {
    vaultDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-agy-test-'));
  });

  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fs.rm(vaultDir, { recursive: true, force: true });
  });

  async function connectDirect(): Promise<Client> {
    const cfg = loadLocalVaultConfig({ VAULT_PATH: vaultDir });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'agy-test', version: '1.0.0' });
    await Promise.all([buildDirectMcpServer(cfg).connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  async function callTool(c: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    return (await c.callTool({ name, arguments: args })) as ToolResult;
  }

  function json(result: ToolResult): any {
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0].text);
  }

  test('exposes all 6 direct-vault MCP tools', async () => {
    const c = await connectDirect();
    const { tools } = await c.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'get_note',
      'reindex_vault',
      'related_notes',
      'save_code_note',
      'save_memos',
      'search_notes',
    ]);
  });

  test('saves code notes and memos, auto-links them by local similarity, and recalls them via search_notes and PreInvocation hook', async () => {
    const c = await connectDirect();

    // 1. Save a code note about JWT refresh token rotation
    const codeSaved = json(
      await callTool(c, 'save_code_note', {
        file_path: 'src/auth/jwt.ts',
        language: 'typescript',
        project: 'auth-service',
        session_id: 'session-1',
        title: 'JWT token refresh with sliding expiry window',
        summary: 'Implements JWT refresh token rotation with a 15-minute sliding expiry window in Redis.',
        key_points: [
          'Rotates refresh tokens on every use to detect replay attacks',
          'Stores token family TTL in Redis cache',
        ],
      }),
    );
    expect(codeSaved.status).toBe('complete');
    expect(codeSaved.name).toContain('auth-service_src_auth_jwt.ts');

    // 2. Save a decision memo in the same session and verify both Same Session and similarity links
    const memoSaved = json(
      await callTool(c, 'save_memos', {
        project: 'auth-service',
        session_id: 'session-1',
        memos: [
          {
            kind: 'decision',
            title: 'Use Redis write-through caching for JWT refresh tokens',
            body: 'In auth-service we chose Redis write-through caching for JWT token rotation so revoked tokens are rejected immediately across all instances.',
            files: ['src/auth/jwt.ts'],
          },
        ],
      }),
    );
    expect(memoSaved.status).toBe('complete');
    expect(memoSaved.memos).toHaveLength(1);
    expect(memoSaved.memos[0].links).toContain(codeSaved.name);

    // 3. Search via local in-process embeddings
    const hits = json(await callTool(c, 'search_notes', { query: 'how did we implement JWT token refresh?' }));
    expect(hits.results.length).toBeGreaterThanOrEqual(1);
    expect(hits.results[0].score).toBeGreaterThanOrEqual(0.6);

    // 4. Test Antigravity PreInvocation hook context injection
    const convId = `test-conv-${Date.now()}`;
    const hookOut = await runAgyPreInvocation(
      {
        conversationId: convId,
        lastUserInput: 'How did we implement JWT refresh token caching in auth-service?',
      },
      { VAULT_PATH: vaultDir },
    );
    expect(hookOut.injectSteps).toBeDefined();
    expect(hookOut.injectSteps![0].systemMessage.systemMessage).toContain('<knowledge-graph-reference-notes>');
    expect(hookOut.injectSteps![0].systemMessage.systemMessage).toContain(codeSaved.name);

    // 5. Second PreInvocation call with identical prompt in same conversation deduplicates
    const duplicateOut = await runAgyPreInvocation(
      {
        conversationId: convId,
        lastUserInput: 'How did we implement JWT refresh token caching in auth-service?',
      },
      { VAULT_PATH: vaultDir },
    );
    expect(duplicateOut.injectSteps).toBeUndefined();

    // 6. Unrelated prompt scores below threshold and injects nothing
    const unrelatedOut = await runAgyPreInvocation(
      {
        conversationId: `${convId}-2`,
        lastUserInput: 'Fix the CSS padding on the footer button',
      },
      { VAULT_PATH: vaultDir },
    );
    expect(unrelatedOut.injectSteps).toBeUndefined();
  });
});

