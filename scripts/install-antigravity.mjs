#!/usr/bin/env node
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function main() {
  const pluginSrc = path.join(ROOT, 'antigravity-plugin', 'knowledge-graph');
  const pluginDest = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'knowledge-graph');
  const vaultPath = process.env.VAULT_PATH || path.join(os.homedir(), 'Documents', 'obsidian');

  // 1. Install global Antigravity plugin
  await fs.mkdir(pluginDest, { recursive: true });
  await fs.cp(pluginSrc, pluginDest, { recursive: true, force: true });
  console.log(`Installed Antigravity plugin to: ${pluginDest}`);

  // 2. Ensure Obsidian vault directories exist
  for (const folder of ['code', 'memos', 'logs']) {
    await fs.mkdir(path.join(vaultPath, folder), { recursive: true });
  }
  console.log(`Initialized Obsidian vault folders in: ${vaultPath}`);

  // 3. Load compiled vault engine, sync existing vault notes, and record initial architecture memo if empty
  const { createDirectVaultEngine, loadLocalVaultConfig } = await import(path.join(ROOT, 'dist', 'vault-engine.js'));
  const cfg = loadLocalVaultConfig({ VAULT_PATH: vaultPath, OLLAMA_EMBED_MODEL: 'local' });
  const engine = createDirectVaultEngine(cfg);

  const syncRes = await engine.callTool('reindex_vault', { rebuild: false });
  if (syncRes.isError) {
    throw new Error(syncRes.text);
  }
  const syncBody = JSON.parse(syncRes.text);
  console.log(`Vault index synced: ${syncBody.notes} note(s) indexed (${syncBody.embedded} newly embedded).`);

  if (syncBody.notes === 0) {
    const seedRes = await engine.callTool('save_memos', {
      project: 'knowledge-graph',
      session_id: 'antigravity-setup',
      memos: [
        {
          kind: 'decision',
          title: 'Package knowledge-graph as an Ollama-free Antigravity plugin with in-process embeddings',
          body: [
            'In knowledge-graph, we replaced the external Ollama and Express daemon dependencies with an all-in-one stdio MCP server and in-process 384-dimensional local embedder (`src/local-embed.ts`, `src/vault-engine.ts`).',
            '',
            '## Why',
            '- Eliminates the need to run Docker or a 9GB local Ollama model in RAM.',
            '- Enables sub-20ms cold-start semantic/lexical search inside Antigravity `PreInvocation` lifecycle hooks (`src/hook/agy-pre-invocation.ts`).',
            '- Exposes both read (`search_notes`, `get_note`, `related_notes`) and write (`save_memos`, `save_code_note`, `reindex_vault`) tools directly over MCP to Antigravity.',
          ].join('\n'),
          files: ['src/local-embed.ts', 'src/vault-engine.ts', 'src/mcp/server.ts', 'src/hook/agy-pre-invocation.ts'],
        },
      ],
    });
    const seedBody = JSON.parse(seedRes.text);
    console.log(`Seeded initial architecture decision memo: ${seedBody.memos?.[0]?.name}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
