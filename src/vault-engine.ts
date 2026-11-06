/**
 * Direct-vault engine for running knowledge-graph without an HTTP server or
 * Ollama daemon. Used by the stdio MCP server in direct mode and by the
 * Antigravity PreInvocation context-injection hook.
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { Config, DEFAULT_NOTE_MAX_CHARS, loadConfig } from './config';
import { createEmbeddingIndex, EmbeddingIndex } from './embedding-index';
import { readNote, relatedNotes } from './graph';
import { GRAPH_TOOLS, REFERENCE_ONLY, ToolReply } from './graph-tools';
import { LOCAL_EMBED_MODEL } from './local-embed';
import { memoLinks, writeMemos } from './memos';
import { MEMO_KINDS, parseMemos, parseSearch } from './requests';
import { appendNote, captureFields, listMarkdownFiles, parseNote, renderFrontmatter, setFrontmatterFields, today, writeNote } from './vault';
import {
  codeNoteName,
  isRecallable,
  linkTargets,
  noteName,
  notePath as notePathIn,
  RELATED_LINKS_HEADING,
  sessionLogName,
  vaultRelative,
  wikilinkTarget,
} from './vault-format';
import { appendLinks, LINK_CANDIDATES } from './agents/linker';

/** Threshold for automatic similarity linking when no LLM linker is used. */
export const AUTO_LINK_MIN_SCORE = 0.62;
export const MAX_AUTO_LINKS = 5;

/** Expands a leading `~/` to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

/**
 * Loads a Config that defaults to local in-process embeddings and expands `~`
 * in `VAULT_PATH` (defaulting to `~/Documents/obsidian` when unset).
 */
export function loadLocalVaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawVault = env.VAULT_PATH || env.KG_VAULT_PATH || path.join(os.homedir(), 'Documents', 'obsidian');
  const vaultPath = path.resolve(expandHome(rawVault));
  const base = loadConfig({
    ...env,
    VAULT_PATH: vaultPath,
    OLLAMA_EMBED_MODEL: env.OLLAMA_EMBED_MODEL || LOCAL_EMBED_MODEL,
  });
  return base;
}

export const DIRECT_VAULT_TOOLS = {
  ...GRAPH_TOOLS,
  save_memos: {
    description:
      'Save one or more memos (decisions, learnings, todos, snippets, conversations) directly to the knowledge-graph ' +
      'Obsidian vault, automatically linking them to same-session notes and semantically related notes, and indexing ' +
      `them for recall. ${REFERENCE_ONLY}`,
    inputSchema: {
      project: z.string().min(1).describe('Name of the current project or git repository'),
      session_id: z.string().min(1).optional().describe('Session or conversation ID (defaults to "antigravity")'),
      memos: z
        .array(
          z.object({
            kind: z.enum(MEMO_KINDS).describe('Memo kind: decision, learning, todo, snippet, or conversation'),
            title: z.string().min(1).describe('One-line self-contained title stating the decision/learning/todo'),
            body: z
              .string()
              .min(1)
              .describe('Self-contained markdown body opening with a context paragraph (project, problem, files)'),
            files: z.array(z.string()).optional().describe('Project-relative file paths this memo concerns'),
            related_notes: z
              .array(z.string())
              .optional()
              .describe('Optional existing note names (without .md) to link under ## Related Notes'),
          }),
        )
        .min(1)
        .max(20)
        .describe('Memos to write and link into the vault'),
    },
  },
  save_code_note: {
    description:
      'Save a structured code documentation note to vault/code/ for a file created or modified in this session, ' +
      `automatically linking it to semantically similar notes in the knowledge graph. ${REFERENCE_ONLY}`,
    inputSchema: {
      file_path: z.string().min(1).describe('Project-relative file path, e.g. "src/auth/jwt.ts"'),
      language: z.string().min(1).describe('Programming language, e.g. "typescript"'),
      project: z.string().min(1).describe('Project or repository name'),
      title: z.string().min(1).describe('Concise descriptive title for the code note'),
      summary: z.string().min(1).describe('2-4 sentence summary of what the code does and why'),
      key_points: z.array(z.string().min(1)).min(1).describe('Bullet points of key implementation details'),
      notes: z.string().optional().describe('Optional caveats, edge cases, TODOs, or observations'),
      tags: z.array(z.string()).optional().describe('Optional tags for YAML frontmatter'),
      related_notes: z
        .array(z.string())
        .optional()
        .describe('Optional existing note names (without .md) to link under ## Related Notes'),
      session_id: z.string().min(1).optional().describe('Session or conversation ID (defaults to "antigravity")'),
    },
  },
  reindex_vault: {
    description:
      'Rebuild or sync the local embedding index (.knowledge-graph/index.json) across all markdown notes in the Obsidian vault.',
    inputSchema: {
      rebuild: z
        .boolean()
        .default(false)
        .describe('When true, rebuilds the entire index from scratch; when false, syncs only new/modified/deleted notes'),
    },
  },
} as const;

export type DirectVaultToolName = keyof typeof DIRECT_VAULT_TOOLS;
export const DIRECT_VAULT_TOOL_NAMES = Object.keys(DIRECT_VAULT_TOOLS) as DirectVaultToolName[];

/** Appends an entry to the day's session log in `vault/logs/`. */
async function appendSessionLog(date: string, lines: string[], cfg: Config): Promise<void> {
  const logFile = notePathIn(cfg.vaultPath, 'logs', sessionLogName(date));
  const entry = [`## ${new Date().toISOString()}`, '', ...lines, ''].join('\n');
  const header = [
    '---',
    `title: "Session Log ${date}"`,
    `date: ${date}`,
    'tags: [log, session]',
    'related: []',
    'source: "antigravity-mcp"',
    'type: "log"',
    '---',
    '',
  ].join('\n');

  let needsHeader = false;
  try {
    await fs.access(logFile);
  } catch {
    needsHeader = true;
  }
  await appendNote(logFile, (needsHeader ? header : '') + entry + '\n');
}

/**
 * Links a newly written note to explicit `requestedLinks` (verified to exist in
 * the vault) plus up to `MAX_AUTO_LINKS` existing notes from the embedding
 * index whose similarity score is at least `AUTO_LINK_MIN_SCORE`.
 */
async function autoLinkNote(
  notePath: string,
  title: string,
  requestedLinks: string[],
  cfg: Config,
  index: EmbeddingIndex,
): Promise<number> {
  let content: string;
  try {
    content = await fs.readFile(notePath, 'utf8');
  } catch {
    return 0;
  }

  const selfRel = vaultRelative(cfg.vaultPath, notePath);
  const selfName = noteName(selfRel);
  const alreadyLinked = new Set(linkTargets(content));

  const chosen: string[] = [];
  if (requestedLinks.length > 0) {
    // Existing recallable note names in the vault for validating explicit links
    const allRelPaths = (await listMarkdownFiles(cfg.vaultPath)).filter(isRecallable);
    const validVaultNames = new Set(allRelPaths.map(noteName));
    for (const raw of requestedLinks) {
      const target = wikilinkTarget(raw);
      if (
        target &&
        target !== selfName &&
        validVaultNames.has(target) &&
        !alreadyLinked.has(target) &&
        !chosen.includes(target)
      ) {
        chosen.push(target);
      }
    }
  }

  // Search embedding index for semantically similar existing notes
  const { frontmatter, body } = parseNote(content);
  const query = `${frontmatter.title || title}\n\n${body.trim()}`.substring(0, 1500);
  const hits = await index.search(query, { limit: LINK_CANDIDATES + 5 });
  for (const hit of hits) {
    if (chosen.length >= MAX_AUTO_LINKS) break;
    if (hit.path === selfRel || hit.name === selfName) continue;
    if (alreadyLinked.has(hit.name) || chosen.includes(hit.name)) continue;
    if (hit.score >= AUTO_LINK_MIN_SCORE) {
      chosen.push(hit.name);
    }
  }

  if (chosen.length === 0) return 0;
  const wikilinks = chosen.slice(0, MAX_AUTO_LINKS).map(n => `[[${n}]]`);
  const updated = appendLinks(content, wikilinks);
  if (!updated) return 0;
  await fs.writeFile(notePath, updated, 'utf8');
  return wikilinks.length;
}

export interface DirectVaultEngine {
  cfg: Config;
  index: EmbeddingIndex;
  callTool(name: string, args: unknown): Promise<ToolReply>;
}

const toolError = (text: string): ToolReply => ({ text, isError: true });
const toolOk = (body: unknown): ToolReply => ({ text: JSON.stringify(body, null, 2), isError: false, body });

export function createDirectVaultEngine(cfg: Config = loadLocalVaultConfig()): DirectVaultEngine {
  const index = createEmbeddingIndex(cfg);
  let initialized = false;

  /** Syncs only if `.knowledge-graph/index.json` does not exist yet. */
  async function ensureIndex(): Promise<void> {
    if (initialized) return;
    initialized = true;
    const indexPath = path.join(cfg.vaultPath, '.knowledge-graph', 'index.json');
    try {
      await fs.access(indexPath);
    } catch {
      await index.sync();
    }
  }

  async function callTool(name: string, args: unknown): Promise<ToolReply> {
    if (!Object.hasOwn(DIRECT_VAULT_TOOLS, name)) {
      return toolError(`There is no tool named "${name}". The tools are ${DIRECT_VAULT_TOOL_NAMES.join(', ')}.`);
    }
    const toolName = name as DirectVaultToolName;
    const schema = z.object(DIRECT_VAULT_TOOLS[toolName].inputSchema);
    const parsed = schema.safeParse(args ?? {});
    if (!parsed.success) {
      return toolError(`Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`);
    }
    const data = parsed.data as Record<string, unknown>;

    try {
      switch (toolName) {
        case 'search_notes': {
          await ensureIndex();
          const searchReq = parseSearch(data);
          if ('error' in searchReq) return toolError(searchReq.error);
          const { query, ...options } = searchReq;
          const results = await index.search(query, options);
          return toolOk({ query, results });
        }

        case 'get_note': {
          const targetName = String(data.name ?? '').trim();
          const note = await readNote(cfg.vaultPath, targetName, cfg.noteMaxChars || DEFAULT_NOTE_MAX_CHARS);
          if (!note) {
            return toolError(`The knowledge-graph service could not answer: No note named "${targetName}"`);
          }
          return toolOk(note);
        }

        case 'related_notes': {
          const targetName = String(data.name ?? '').trim();
          const related = await relatedNotes(cfg.vaultPath, targetName);
          if (!related) {
            return toolError(`The knowledge-graph service could not answer: No note named "${targetName}"`);
          }
          return toolOk(related);
        }

        case 'save_memos': {
          const input = data as {
            project: string;
            session_id?: string;
            memos: Array<{
              kind: (typeof MEMO_KINDS)[number];
              title: string;
              body: string;
              files?: string[];
              related_notes?: string[];
            }>;
          };
          const sessionId = input.session_id?.trim() || 'antigravity';
          const stamped = input.memos.map(m => ({
            ...m,
            project: input.project.trim(),
            session_id: sessionId,
          }));
          const validated = parseMemos({ memos: stamped });
          if ('error' in validated) return toolError(validated.error);

          await ensureIndex();
          const date = today();
          await appendSessionLog(
            date,
            validated.memos.map(m => `- **Memo (${m.kind}):** ${m.title}`),
            cfg,
          );

          const written = await writeMemos(validated.memos, date, cfg);
          let linksWritten = 0;
          for (let i = 0; i < written.length; i++) {
            const w = written[i];
            const explicitLinks = input.memos[i]?.related_notes ?? [];
            const count = await autoLinkNote(w.notePath, w.memo.title, explicitLinks, cfg, index);
            if (count > 0) linksWritten++;
          }

          await index.indexNotes(written.map(w => w.notePath));
          const memosReply = await Promise.all(
            written.map(async w => ({
              name: w.name,
              note_path: w.notePath,
              kind: w.memo.kind,
              links: await memoLinks(w),
            })),
          );

          return toolOk({
            status: 'complete',
            session_date: date,
            memos: memosReply,
            linker: { status: 'success', links_written: linksWritten },
          });
        }

        case 'save_code_note': {
          const input = data as {
            file_path: string;
            language: string;
            project: string;
            title: string;
            summary: string;
            key_points: string[];
            notes?: string;
            tags?: string[];
            related_notes?: string[];
            session_id?: string;
          };
          await ensureIndex();
          const date = today();
          const sessionId = input.session_id?.trim() || 'antigravity';
          const noteFileName = codeNoteName(date, input.project, input.file_path);
          const fullPath = notePathIn(cfg.vaultPath, 'code', noteFileName);

          const fm = renderFrontmatter({
            title: input.title.trim(),
            date,
            tags: input.tags && input.tags.length > 0 ? input.tags : ['code', input.language.toLowerCase()],
            related: [],
            source: 'antigravity-mcp',
            type: 'code',
          });

          const bodySections = [
            fm,
            '',
            '## Summary',
            input.summary.trim(),
            '',
            '## Key Points',
            ...input.key_points.map(pt => `- ${pt.replace(/^[-*]\s+/, '').trim()}`),
            ...(input.notes?.trim() ? ['', '## Notes', input.notes.trim()] : []),
            '',
          ].join('\n');

          const withCaptureFields = setFrontmatterFields(
            bodySections,
            captureFields('code', { project: input.project.trim(), session: sessionId }),
          );
          await writeNote(fullPath, withCaptureFields);

          await appendSessionLog(
            date,
            [
              `- **File:** ${input.file_path}`,
              `- **Language:** ${input.language}`,
              `- **Description:** ${input.title}`,
            ],
            cfg,
          );

          const linksWritten = await autoLinkNote(
            fullPath,
            input.title,
            input.related_notes ?? [],
            cfg,
            index,
          );
          await index.indexNotes([fullPath]);

          const finalContent = await fs.readFile(fullPath, 'utf8');
          return toolOk({
            status: 'complete',
            session_date: date,
            name: noteName(fullPath),
            note_path: fullPath,
            project: input.project,
            links: linkTargets(finalContent),
            linker: { status: 'success', links_written: linksWritten > 0 ? 1 : 0 },
          });
        }

        case 'reindex_vault': {
          const { rebuild } = data as { rebuild?: boolean };
          const summary = rebuild ? await index.rebuild() : await index.sync();
          return toolOk({ status: 'ok', vault_path: cfg.vaultPath, embed_model: cfg.embedModel, ...summary });
        }
      }
    } catch (err) {
      return toolError(`Knowledge graph operation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { cfg, index, callTool };
}
