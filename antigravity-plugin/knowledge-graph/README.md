# Knowledge Graph Plugin for Antigravity

Local, Ollama-free personal knowledge graph backed by your Obsidian vault (`__VAULT_PATH__`).

## Features

- **Zero Daemons / Zero Ollama**: Runs local 384-dimensional feature-hashed semantic/lexical embeddings in-process in Node (`src/local-embed.ts`). No Docker or Ollama server required.
- **Automatic `PreInvocation` Context Injection**: Searches `__VAULT_PATH__` before every prompt and injects matching notes (`score >= 0.60`) in a `<knowledge-graph-reference-notes>` system message block (deduplicated per prompt).
- **All-in-One Stdio MCP Server (`knowledge-graph`)**:
  - `search_notes`: Semantic/lexical section search across your Obsidian vault
  - `get_note`: Read full note markdown and YAML frontmatter
  - `related_notes`: Walk incoming and outgoing `[[wikilinks]]`
  - `save_memos`: Save `decision`, `learning`, `todo`, `snippet` and `conversation` memos with automatic same-session and similarity `[[wikilinks]]`
  - `save_code_note`: Document code changes into `vault/code/` with automatic similarity `[[wikilinks]]`
  - `reindex_vault`: Sync or rebuild `.knowledge-graph/index.json`
- **Skills**: `/remember` and `/recall`
