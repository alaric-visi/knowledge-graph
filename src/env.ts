/**
 * Reading settings from the environment, shared by the service and its
 * clients (the hooks, /remember, the MCP server, `npm run reindex` and `npm run ask`).
 */

/** Where the clients find the service unless KG_SERVICE_URL says otherwise. */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:5678';

/** The service's base URL from KG_SERVICE_URL, without a trailing slash. */
export function serviceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.KG_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
}

/** A whole number above zero, or `fallback` when the setting is unset or anything else. */
export function positiveInt(value: string | undefined, fallback: number): number {
  const n = parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/;

/** Whether `url` points at this machine's loopback interface (127.0.0.1, ::1, localhost). False for anything that isn't a URL. */
export function isLoopback(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
}
