# Planned Code Block Improvements

This document captures planned improvements for how `knowledge-graph` parses, chunks, links and formats fenced code blocks in Obsidian notes. No codebase changes have been applied yet.

---

## 1. Guarantee Prism.js Syntax Highlighting Tags on Code Fences

### Problem
Obsidian uses **Prism.js** in Reading View (and CodeMirror 6 in Live Preview) to syntax-highlight fenced code blocks, which requires a lowercase language identifier on the opening fence (for example ```` ```typescript ```` or ```` ```python ````). Currently:
- In `src/agents/documenter.ts` (`userPrompt()`, lines 18-21), the code diff is placed inside a bare ```` ``` ```` block without `${ctx.language}`, and the prompt template does not instruct the model to include the language identifier when writing fenced code snippets.
- In `src/vault-engine.ts` (`save_code_note`, lines 85-109 and 320-396), the tool accepts `language` (`e.g. "typescript"`) for frontmatter tags and session logs, but does not offer an optional `code_snippet` field that automatically wraps key code in a ```` ```<language> ```` block, nor does it normalise bare ```` ``` ```` fences in `summary` or `notes` using `languageFromPath()` (`src/hook/payload.ts`, lines 72-93).

### Proposed Plan
1. **`src/vault-engine.ts` (`save_code_note`)**:
   - Add an optional `code_snippet` string field to `DIRECT_VAULT_TOOLS.save_code_note.inputSchema`.
   - Map `language` (or `languageFromPath(file_path)`) to its canonical Prism.js language tag and render a `## Code` section wrapped in ```` ```<language> ... ``` ````.
   - Normalise any bare opening code fences (` ```\n `) in `summary`, `notes` or memo `body` by attaching the inferred Prism.js language tag when `files` or `file_path` is known.
2. **`src/agents/documenter.ts` (`userPrompt`)**:
   - Change line 19 from ```` ``` ```` to ```` ```${ctx.language} ```` and instruct the Documenter to always tag fenced code blocks with `${ctx.language}`.
3. **`antigravity-plugin/knowledge-graph/skills/remember/SKILL.md`**:
   - Explicitly require Prism.js language identifiers on all fenced code blocks in `snippet` memos and code notes.

---

## 2. Ignore `[[...]]` Inside Fenced Code Blocks and Inline Code When Extracting Wikilinks

### Problem
In `src/vault-format.ts` (`wikilinks()` and `linkTargets()`, lines 92-99), `[[wikilinks]]` are extracted by running a global regex across the entire raw Markdown body:

```ts
function wikilinks(text: string): string[] {
  return [...text.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => wikilinkTarget(m[1])).filter(n => n !== '');
}
```

Unlike `splitSections()` in `src/embedding-index.ts` (lines 101-112), `wikilinks()` does not skip fenced code blocks (```` ``` ```` or `~~~`) or inline code spans (`` `...` ``). Consequently, shell conditionals like `if [[ $x == 1 ]]` or nested array expressions like `a[[i]]` inside a code block are parsed as wikilink targets.

### Proposed Plan
1. **`src/vault-format.ts`**:
   - Add a helper `stripCodeBlocks(text: string): string` that strips fenced code blocks (` ```...``` ` and `~~~...~~~`) and inline backtick spans before running `/\[\[([^\]]+)\]\]/g` in `wikilinks()`.
2. **`tests/vault.test.ts` & `tests/notes.test.ts`**:
   - Add unit tests verifying that `[[...]]` inside Bash, Python or TypeScript code blocks are ignored by `linkTargets()` and `relatedNotes()`.

---

## 3. Keep Fenced Code Blocks Intact During Section Chunking and Snippet Truncation

### Problem
In `src/embedding-index.ts`:
- **Section chunking (`chunkSection()`, lines 141-159)**: Sections exceeding `CHUNK_CHARS` (`1500` characters) are split on blank lines (`/\n\s*\n/`). When a fenced code block contains blank lines and spans a chunk boundary, the first chunk loses its closing ```` ``` ```` fence and the second chunk loses its opening ```` ```<lang> ```` fence.
- **Search snippet truncation (`snippet()`, lines 218-220)**: Truncating a matched section at `SNIPPET_LENGTH` (`300` characters) mid-code-block leaves an unclosed ```` ``` ```` fence, which can break Markdown formatting when rendered inside `<knowledge-graph-reference-notes>`.

### Proposed Plan
1. **`src/embedding-index.ts` (`chunkSection()`)**:
   - Track whether a chunk boundary falls inside an open code fence (` ```<lang> `). When splitting inside a fenced block, close the fence (`\n``` `) at the end of the outgoing chunk and reopen it (` ```<lang>\n `) immediately after the `## <heading>` label at the start of the next chunk.
2. **`src/embedding-index.ts` (`snippet()`)**:
   - Count fence markers (`/^```/gm`) in the truncated snippet; if the count is odd, append `\n``` ` so every search snippet and injected context block has balanced Markdown fences.

---

## 4. Sanitise Raw HTML Outside Code Fences and Neutralise Executable Obsidian Plugin Blocks

### Problem
Whilst `knowledge-graph` itself only serves JSON and plain text, the Markdown files it writes via `writeNote()` (`src/vault.ts`, lines 108-111) are opened and rendered inside Obsidian's Electron DOM. Currently, note bodies written by `runDocumenter()` (`src/agents/documenter.ts`), `writeMemos()` (`src/memos.ts`) and `save_code_note` (`src/vault-engine.ts`) are written to disk without sanitising raw HTML outside code blocks or filtering executable code-fence language tags:
- **Raw HTML in prose**: Any `<iframe src="...">`, `<img src="...">`, `<style>`, `<svg>` or `<script>` written in prose outside of a fenced code block (```` ``` ````) or inline code span (`` `...` ``) is parsed by Obsidian's Markdown renderer. Although Obsidian's DOMPurify strips `<script>` and inline event handlers, tags such as `<iframe>`, `<style>` and `<img>` still render live and can trigger external network requests or alter Obsidian's UI.
- **Executable Obsidian plugin fences**: If a captured file or LLM response includes a fenced block tagged with an executable Obsidian community plugin identifier such as ```` ```dataviewjs ````, ```` ```js-engine ```` or Templater syntax (`<%* ... %>`), those plugins will execute the JavaScript inside Obsidian with local filesystem access when the note is opened.

### Proposed Plan
1. **`src/vault.ts` (`sanitiseNoteMarkdown()`)**:
   - Before writing note content in `writeNote()` (or when formatting notes in `src/vault-engine.ts`, `src/memos.ts` and `src/agents/documenter.ts`), pass the body through a pure sanitiser that:
     - Rewrites executable Obsidian fence tags (`dataviewjs`, `js-engine`, `templater`, `customjs`) on opening code fences to `javascript` so they are syntax-highlighted by Prism.js as inert code rather than executed.
     - Escapes Templater execution tags (`<%` -> `&lt;%`) when they appear outside fenced code blocks.
     - Escapes dangerous raw HTML tags (`<script`, `<iframe`, `<style`, `<object`, `<embed`, `<link`, `<meta`) when they appear in prose outside fenced code blocks or inline code spans, whilst leaving them untouched inside ```` ```html ```` or ```` ```tsx ```` blocks.
2. **`tests/vault.test.ts`**:
   - Add unit tests verifying that raw `<iframe>`, `<style>` and `<script>` tags in prose are escaped, `dataviewjs` fences are rewritten to `javascript` and code inside standard fenced blocks remains verbatim.


