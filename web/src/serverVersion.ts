import { LATEST_RELEASE } from './changelog.js';

declare const __HANDMUX_CLIENT_VERSION__: string | undefined;

export const SERVER_VERSION_HEADER = 'X-Handmux-Server-Version';
export const SERVER_VERSION_EVENT = 'handmux:server-version';

// Vite injects this from server/package.json. The changelog fallback keeps source-level test/dev
// environments usable when the module is evaluated without the Vite define.
const CLIENT_VERSION = typeof __HANDMUX_CLIENT_VERSION__ === 'string'
  ? __HANDMUX_CLIENT_VERSION__ : LATEST_RELEASE;

let reloadRequired = false;

interface ParsedVersion {
  core: [number, number, number];
  build: string | null;
}

function parseVersion(value: unknown): ParsedVersion | null {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:\+([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    build: match[4] ?? null,
  };
}

function isNewerServerVersion(value: unknown): boolean {
  const server = parseVersion(value);
  const client = parseVersion(CLIENT_VERSION);
  if (!server || !client) return false;
  for (let i = 0; i < 3; i += 1) {
    const left = server.core[i] ?? 0;
    const right = client.core[i] ?? 0;
    if (left !== right) return left > right;
  }
  // A legacy page may carry only the semantic release version. Once the server exposes a
  // build identity, that page cannot prove it is running the same artifact, so require one
  // refresh to move it onto the identity-aware client. Two identity-aware pages only differ
  // when their concrete build IDs differ.
  if (!server.build) return false;
  if (!client.build) return true;
  return server.build !== client.build;
}

export function observeServerVersion(value: string | null | undefined): void {
  if (!isNewerServerVersion(value)) return;
  const wasRequired = reloadRequired;
  reloadRequired = true;
  if (!wasRequired && typeof window !== 'undefined') window.dispatchEvent(new Event(SERVER_VERSION_EVENT));
}

export function observeServerResponse(response: { headers?: { get?: (name: string) => string | null } }): void {
  observeServerVersion(response.headers?.get?.(SERVER_VERSION_HEADER));
}

export function serverReloadRequired(): boolean { return reloadRequired; }
