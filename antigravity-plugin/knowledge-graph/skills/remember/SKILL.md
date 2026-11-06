---
name: remember
description: Save what is worth keeping from this conversation (decisions, learnings, todos, snippets, conversations, or code notes) into the Obsidian knowledge graph via the knowledge-graph MCP server.
---

# Remember

Distil what we worked on in this conversation into **self-contained memos** (and optionally **code notes**) in the Obsidian knowledge graph (`/Users/mikehiggins/Documents/obsidian`), so an agent in another session or project can recall it months from now.

## 1. Choose what to capture

- **If the user specified what to remember**: capture just that.
- **If the user ran `/remember` with no argument**: capture everything worth keeping since the last memo saved in this conversation (or since the start of the session). Write one memo per distinct item (e.g., a decision and a todo are two separate memos in the `memos` array, never blended into one).

## 2. Choose each memo's `kind`

| Kind | For | Body carries |
|------|-----|--------------|
| `decision` | A choice that was made | What was chosen, the alternatives rejected, and why (include full ADR content if applicable) |
| `todo` | Something left to do | What to do, why, and where to start (automatically receives `status: "open"`) |
| `learning` | A gotcha, tool behavior, or root cause of a bug | The finding and the evidence for it |
| `snippet` | A script, command, or query worth reusing | The code verbatim in a fenced block, what it is for, and how to run it |
| `conversation` | A broader design discussion | The question, the options weighed, and where it landed |

## 3. Write self-contained content

- **`title`**: One line stating the substance directly (e.g., `"Use write-through caching for the session cache"`, not `"Caching decision"`).
- **`body`**: Markdown opening with a **context paragraph** naming the project, the problem being worked on, and the files involved. Use `##` section headings for longer notes because each `##` section is embedded and searched independently.
- **`files`**: Optional list of project-relative file paths the memo concerns.
- **Privacy**: Never include credentials, tokens, API keys, passwords, private keys, or personal data. Use placeholders like `$API_TOKEN`.

## 4. Save via the `knowledge-graph` MCP Server

Call the `save_memos` tool on the `knowledge-graph` MCP server (using `call_mcp_tool` with `ServerName: "knowledge-graph"`, `ToolName: "save_memos"`, or directly if loaded):

```json
{
  "project": "<git repo or workspace folder name>",
  "session_id": "<conversation ID>",
  "memos": [
    {
      "kind": "decision",
      "title": "...",
      "body": "...",
      "files": ["src/example.ts"]
    }
  ]
}
```

If significant code files were created or modified and warrant a dedicated code summary note in `vault/code/`, also call `save_code_note` on `knowledge-graph`.

## 5. Report back

Tell the user each saved note's name, `kind`, file path in `/Users/mikehiggins/Documents/obsidian`, and the `[[wikilinks]]` it was connected to.

