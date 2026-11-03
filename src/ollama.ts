export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Where an Ollama API is, and the key it takes, if any. The key is only ever sent to this URL. */
export interface OllamaEndpoint {
  url: string;
  /** Sent as a bearer token: hosted Ollama (https://ollama.com) needs one, a local Ollama doesn't. */
  apiKey?: string;
}

function headers(endpoint: OllamaEndpoint): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
  };
}

/**
 * Extracts assistant text from an LLM response, supporting both the native
 * Ollama format ({message: {content}}) and the OpenAI-compatible format
 * ({choices: [{message: {content}}]}). Returns '' if neither is present.
 */
export function extractContent(response: unknown): string {
  const r = response as {
    message?: { content?: string };
    choices?: Array<{ message?: { content?: string } }>;
  };
  return r?.message?.content ?? r?.choices?.[0]?.message?.content ?? '';
}

/**
 * Sends a chat completion request to Ollama and returns the assistant text.
 * Throws on non-2xx responses so callers can decide how to degrade.
 * `think` is sent explicitly: Ollama ignores it for non-thinking models.
 */
export async function chat(
  endpoint: OllamaEndpoint,
  model: string,
  messages: ChatMessage[],
  think = false,
): Promise<string> {
  const res = await fetch(`${endpoint.url}/api/chat`, {
    method: 'POST',
    headers: headers(endpoint),
    body: JSON.stringify({ model, stream: false, think, messages }),
  });

  if (!res.ok) {
    throw new Error(`Ollama request failed: HTTP ${res.status} ${res.statusText}`);
  }

  return extractContent(await res.json());
}

/**
 * Embeds texts with Ollama's /api/embed, returning one vector per input, in
 * order. Throws on non-2xx responses or a reply without one vector per input.
 */
export async function embed(endpoint: OllamaEndpoint, model: string, input: string[]): Promise<number[][]> {
  if (input.length === 0) return [];
  const res = await fetch(`${endpoint.url}/api/embed`, {
    method: 'POST',
    headers: headers(endpoint),
    // Truncation is Ollama's default, but sections are chunked to fit, so
    // it's only a backstop; sent explicitly in case the default changes.
    body: JSON.stringify({ model, input, truncate: true }),
  });

  if (!res.ok) {
    throw new Error(`Ollama embed request failed: HTTP ${res.status} ${res.statusText}`);
  }

  const embeddings = ((await res.json()) as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== input.length) {
    throw new Error(`Ollama embed reply did not hold ${input.length} embedding(s)`);
  }
  return embeddings as number[][];
}
