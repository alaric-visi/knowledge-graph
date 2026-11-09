#!/usr/bin/env node
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function parseVaultFlag(argv) {
  const idx = argv.indexOf('--vault');
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : undefined;
}

async function replacePlaceholdersInDir(dir, replacements) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await replacePlaceholdersInDir(fullPath, replacements);
    } else if (entry.name.endsWith('.json') || entry.name.endsWith('.md')) {
      let text = await fs.readFile(fullPath, 'utf8');
      for (const [token, value] of Object.entries(replacements)) {
        text = text.split(token).join(value);
      }
      await fs.writeFile(fullPath, text, 'utf8');
    }
  }
}

async function main() {
  const pluginSrc = path.join(ROOT, 'antigravity-plugin', 'knowledge-graph');
  const pluginDest = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'knowledge-graph');
  const rawVault =
    parseVaultFlag(process.argv.slice(2)) ||
    process.env.VAULT_PATH ||
    process.env.KG_VAULT_PATH ||
    path.join(os.homedir(), 'Documents', 'obsidian');
  const vaultPath = path.resolve(expandHome(rawVault));

  // 1. Copy Antigravity plugin template and populate machine-local paths
  await fs.mkdir(pluginDest, { recursive: true });
  await fs.cp(pluginSrc, pluginDest, { recursive: true, force: true });
  await replacePlaceholdersInDir(pluginDest, {
    __REPO_ROOT__: ROOT,
    __VAULT_PATH__: vaultPath,
  });
  console.log(`Installed Antigravity plugin to: ${pluginDest}`);
  console.log(`Configured repository root:      ${ROOT}`);
  console.log(`Configured Obsidian vault path:  ${vaultPath}`);

  // 2. Ensure Obsidian vault directories exist
  for (const folder of ['code', 'memos', 'logs']) {
    await fs.mkdir(path.join(vaultPath, folder), { recursive: true });
  }
  console.log(`Initialised Obsidian vault folders in: ${vaultPath}`);

  // 3. Load compiled vault engine, sync existing vault notes and record initial architecture memo if empty
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
