import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { chat, embed, extractContent } from '../src/ollama';
import { close, createMockOllama, createMockOllamaState, listen, resetMockOllamaState } from './helpers/mock-ollama';

describe('extractContent', () => {
  test('extracts from native Ollama format', () => {
    expect(extractContent({ message: { content: '# Hello' } })).toBe('# Hello');
  });

  test('extracts from OpenAI-compatible format', () => {
    expect(
      extractContent({ choices: [{ message: { content: '# Hello OAI' } }] }),
    ).toBe('# Hello OAI');
  });

  test('returns empty string for empty object', () => {
    expect(extractContent({})).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(extractContent(null)).toBe('');
    expect(extractContent(undefined)).toBe('');
  });

  test('prefers Ollama format when both are present', () => {
    const resp = {
      message: { content: 'ollama' },
      choices: [{ message: { content: 'openai' } }],
    };
    expect(extractContent(resp)).toBe('ollama');
  });
});

describe('the API key', () => {
  const state = createMockOllamaState();
  const server = createMockOllama(state);
  let url: string;

  beforeAll(async () => {
    url = `http://127.0.0.1:${await listen(server)}`;
  });
  afterAll(() => close(server));
  beforeEach(() => resetMockOllamaState(state));

  test('a chat request carries the key as a bearer token', async () => {
    await chat({ url, apiKey: 'secret-key' }, 'mock', [{ role: 'user', content: 'hi' }]);
    expect(state.requests).toEqual([{ path: '/api/chat', authorization: 'Bearer secret-key' }]);
  });

  test('an embed request carries the key as a bearer token', async () => {
    await embed({ url, apiKey: 'secret-key' }, 'mock-embed', ['docker']);
    expect(state.requests).toEqual([{ path: '/api/embed', authorization: 'Bearer secret-key' }]);
  });

  test('without a key, neither request has an Authorization header', async () => {
    await chat({ url }, 'mock', [{ role: 'user', content: 'hi' }]);
    await embed({ url }, 'mock-embed', ['docker']);
    expect(state.requests).toEqual([
      { path: '/api/chat', authorization: undefined },
      { path: '/api/embed', authorization: undefined },
    ]);
  });
});
