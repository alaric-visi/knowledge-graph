/**
 * The knowledge-graph MCP server.
 *
 * Supports two modes over stdio:
 * 1. Direct Vault Mode (`buildDirectMcpServer`, used in Antigravity when
 *    `VAULT_PATH` or `KG_DIRECT_VAULT=1` is set without `KG_SERVICE_URL`):
 *    operates directly on the Obsidian vault filesystem with in-process
 *    local embeddings — no HTTP service or Ollama required.
 * 2. HTTP Service Mode (`buildMcpServer(baseUrl)`): forwards recall tool
 *    calls (`search_notes`, `get_note`, `related_notes`) to the HTTP service.
 *
 * stdout carries MCP messages and nothing else: never console.log here.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from '../config';
import { serviceUrl } from '../env';
import { GRAPH_TOOLS, GRAPH_TOOL_NAMES, callGraphTool } from '../graph-tools';
import {
  createDirectVaultEngine,
  DIRECT_VAULT_TOOLS,
  DIRECT_VAULT_TOOL_NAMES,
  loadLocalVaultConfig,
} from '../vault-engine';

/** Builds the HTTP-backed MCP server; `baseUrl` is the service's base URL, as serviceUrl() gives it. */
export function buildMcpServer(baseUrl: string): McpServer {
  const server = new McpServer({ name: 'knowledge-graph', version: '1.0.0' });

  for (const name of GRAPH_TOOL_NAMES) {
    const { description, inputSchema } = GRAPH_TOOLS[name];
    server.registerTool(name, { description, inputSchema }, async (args: unknown): Promise<CallToolResult> => {
      const reply = await callGraphTool(baseUrl, name, args);
      return { content: [{ type: 'text', text: reply.text }], ...(reply.isError && { isError: true }) };
    });
  }

  return server;
}

/**
 * Builds the all-in-one direct-vault MCP server that reads, searches, writes,
 * links, and indexes notes directly in `cfg.vaultPath` without needing Ollama
 * or a separate Express server.
 */
export function buildDirectMcpServer(cfg: Config = loadLocalVaultConfig()): McpServer {
  const server = new McpServer({ name: 'knowledge-graph', version: '1.0.0' });
  const engine = createDirectVaultEngine(cfg);

  for (const name of DIRECT_VAULT_TOOL_NAMES) {
    const { description, inputSchema } = DIRECT_VAULT_TOOLS[name];
    server.registerTool(name, { description, inputSchema }, async (args: unknown): Promise<CallToolResult> => {
      const reply = await engine.callTool(name, args);
      return { content: [{ type: 'text', text: reply.text }], ...(reply.isError && { isError: true }) };
    });
  }

  return server;
}

if (require.main === module) {
  const useDirectVault =
    process.env.KG_DIRECT_VAULT === '1' ||
    (Boolean(process.env.VAULT_PATH || process.env.KG_VAULT_PATH) && !process.env.KG_SERVICE_URL);
  const server = useDirectVault ? buildDirectMcpServer(loadLocalVaultConfig()) : buildMcpServer(serviceUrl());
  server.connect(new StdioServerTransport()).catch(err => {
    console.error(`knowledge-graph mcp: ${String(err)}`);
    process.exit(1);
  });
}
