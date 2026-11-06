/**
 * Antigravity PreInvocation hook: automatic knowledge-graph context injection.
 *
 * Reads the Antigravity PreInvocation JSON payload from stdin, searches the
 * Obsidian vault locally in-process (no HTTP daemon or Ollama required), and
 * outputs `{ "injectSteps": [{ "systemMessage": { "systemMessage": "..." } }] }`
 * when relevant notes clear the similarity threshold.
 *
 * Deduplicates per (conversationId, lastUserInput) so multi-step tool loops
 * within the same user turn never inject the same notes twice.
 */
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createEmbeddingIndex } from '../embedding-index';
import { loadLocalVaultConfig } from '../vault-engine';
import { loadInjectionConfig, MAX_QUERY_CHARS, renderContext } from './injection';
import { readStdin } from './io';

const HARD_DEADLINE_MS = 4000;

export interface AgyPreInvocationInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  artifactDirectoryPath?: string;
  modelName?: string;
  lastUserInput?: string;
  invocationNum?: number;
  initialNumSteps?: number;
  /** Fallback when invoked with a `prompt` field in manual tests. */
  prompt?: string;
}

export interface AgyPreInvocationOutput {
  injectSteps?: Array<{
    systemMessage: {
      systemMessage: string;
      metadata?: Record<string, unknown>;
    };
  }>;
  terminationBehavior?: string;
}

/** Deduplication marker path for a conversation so tool-call loops don't re-inject on the same prompt. */
function stateFilePath(conversationId: string): string {
  const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(os.tmpdir(), `kg-agy-preinv-${safe}.hash`);
}

function hashPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

async function alreadyInjectedForPrompt(conversationId: string | undefined, prompt: string): Promise<boolean> {
  if (!conversationId) return false;
  const file = stateFilePath(conversationId);
  const currentHash = hashPrompt(prompt);
  try {
    const prev = (await fs.readFile(file, 'utf8')).trim();
    if (prev === currentHash) return true;
  } catch {
    // First prompt in this conversation
  }
  try {
    await fs.writeFile(file, currentHash, 'utf8');
  } catch {
    // Ignore tmp write failures
  }
  return false;
}

/**
 * Runs the Antigravity PreInvocation context-injection logic and returns the
 * hook JSON output object.
 */
export async function runAgyPreInvocation(
  input: AgyPreInvocationInput,
  env: NodeJS.ProcessEnv = process.env,
  opts: { deduplicate?: boolean } = {},
): Promise<AgyPreInvocationOutput> {
  const injCfg = loadInjectionConfig(env);
  if (injCfg.disabled) return {};

  const rawPrompt = (input.lastUserInput ?? input.prompt ?? '').trim();
  if (!rawPrompt || rawPrompt.startsWith('/')) return {};

  if (opts.deduplicate !== false && (await alreadyInjectedForPrompt(input.conversationId, rawPrompt))) {
    return {};
  }

  const vaultCfg = loadLocalVaultConfig(env);
  const index = createEmbeddingIndex(vaultCfg);
  const indexPath = path.join(vaultCfg.vaultPath, '.knowledge-graph', 'index.json');
  try {
    await fs.access(indexPath);
  } catch {
    await index.sync();
  }

  const query = rawPrompt.slice(0, MAX_QUERY_CHARS);
  const results = await index.search(query, { limit: injCfg.maxNotes });
  const context = renderContext(results, injCfg);
  if (!context) return {};

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: context,
        },
      },
    ],
  };
}

async function main(): Promise<void> {
  const debug = process.env.KG_DEBUG === '1';
  const log = (msg: string): void => {
    if (debug) process.stderr.write(`[knowledge-graph agy-pre-invocation] ${msg}\n`);
  };

  let input: AgyPreInvocationInput = {};
  try {
    const raw = (await readStdin(500)).trim();
    if (raw) input = JSON.parse(raw) as AgyPreInvocationInput;
  } catch (err) {
    log(`invalid stdin JSON: ${String(err)}`);
    process.stdout.write('{}\n');
    return;
  }

  const output = await runAgyPreInvocation(input, process.env);
  if (output.injectSteps && output.injectSteps.length > 0) {
    log(`injected ${output.injectSteps[0].systemMessage.systemMessage.length} chars`);
  } else {
    log('no context injected');
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (require.main === module) {
  setTimeout(() => {
    process.stdout.write('{}\n');
    process.exit(0);
  }, HARD_DEADLINE_MS).unref();

  main()
    .catch(err => {
      if (process.env.KG_DEBUG === '1') {
        process.stderr.write(`[knowledge-graph agy-pre-invocation] error: ${String(err)}\n`);
      }
      process.stdout.write('{}\n');
    })
    .finally(() => process.exit(0));
}

