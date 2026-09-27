import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_VERSION_HEADER = 'X-Handmux-Server-Version';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER_VERSION = (() => {
  try {
    const value: unknown = JSON.parse(readFileSync(resolve(here, '../package.json'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as { version?: unknown }).version === 'string'
      ? (value as { version: string }).version : null;
  } catch { return null; }
})();
