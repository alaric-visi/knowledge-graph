import { describe, test, expect } from 'vitest';
import { loadConfig } from '../src/config';

describe('Ollama endpoints', () => {
  test('by default, chat and embeddings both go to OLLAMA_URL with no key', () => {
    const cfg = loadConfig({ OLLAMA_URL: 'http://127.0.0.1:11434' });
    expect(cfg.chatEndpoint).toEqual({ url: 'http://127.0.0.1:11434' });
    expect(cfg.embedEndpoint).toEqual({ url: 'http://127.0.0.1:11434' });
  });

  test('OLLAMA_API_KEY goes with OLLAMA_URL, for embeddings too when they share it', () => {
    const cfg = loadConfig({ OLLAMA_URL: 'https://ollama.com', OLLAMA_API_KEY: 'chat-key' });
    expect(cfg.chatEndpoint).toEqual({ url: 'https://ollama.com', apiKey: 'chat-key' });
    expect(cfg.embedEndpoint).toEqual({ url: 'https://ollama.com', apiKey: 'chat-key' });
  });

  test('OLLAMA_EMBED_URL sends embeddings elsewhere, without the chat key', () => {
    const cfg = loadConfig({
      OLLAMA_URL: 'https://ollama.com',
      OLLAMA_API_KEY: 'chat-key',
      OLLAMA_EMBED_URL: 'http://127.0.0.1:11434',
    });
    expect(cfg.chatEndpoint).toEqual({ url: 'https://ollama.com', apiKey: 'chat-key' });
    expect(cfg.embedEndpoint).toEqual({ url: 'http://127.0.0.1:11434' });
  });

  test('OLLAMA_EMBED_API_KEY goes with the embeddings endpoint only', () => {
    const cfg = loadConfig({
      OLLAMA_URL: 'http://127.0.0.1:11434',
      OLLAMA_EMBED_URL: 'https://ollama.com',
      OLLAMA_EMBED_API_KEY: 'embed-key',
    });
    expect(cfg.chatEndpoint).toEqual({ url: 'http://127.0.0.1:11434' });
    expect(cfg.embedEndpoint).toEqual({ url: 'https://ollama.com', apiKey: 'embed-key' });
  });

  test('a trailing slash on a URL is dropped', () => {
    const cfg = loadConfig({ OLLAMA_URL: 'https://ollama.com/', OLLAMA_EMBED_URL: 'http://127.0.0.1:11434/' });
    expect(cfg.chatEndpoint.url).toBe('https://ollama.com');
    expect(cfg.embedEndpoint.url).toBe('http://127.0.0.1:11434');
  });
});
