import { LATEST_RELEASE } from './changelog.js';

declare const __HANDMUX_CLIENT_VERSION__: string | undefined;

export const SERVER_VERSION_HEADER = 'X-Handmux-Server-Version';
export const SERVER_VERSION_EVENT = 'handmux:server-version';

// Vite injects this from server/package.json. The changelog fallback keeps source-level test/dev
// environments usable when the module is evaluated without the Vite define.
const CLIENT_VERSION = typeof __HANDMUX_CLIENT_VERSION__ === 'string'
  ? __HANDMUX_CLIENT_VERSION__ : LATEST_RELEASE;

let reloadRequired = false;

function versionParts(value: unknown): [number, number, number] | null {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerServerVersion(value: unknown): boolean {
  const server = versionParts(value);
  const client = versionParts(CLIENT_VERSION);
  if (!server || !client) return false;
  for (let i = 0; i < 3; i += 1) {
    const left = server[i] ?? 0;
    const right = client[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

export function observeServerVersion(value: string | null | undefined): void {
  if (!isNewerServerVersion(value)) return;
  const wasRequired = reloadRequired;
  reloadRequired = true;
  if (!wasRequired && typeof window !== 'undefined') window.dispatchEvent(new Event(SERVER_VERSION_EVENT));
}

export function observeServerResponse(response: { headers: { get(name: string): string | null } }): void {
  observeServerVersion(response.headers.get(SERVER_VERSION_HEADER));
}

export function serverReloadRequired(): boolean { return reloadRequired; }
