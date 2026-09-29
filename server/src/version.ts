import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_VERSION_HEADER = 'X-Handmux-Server-Version';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch { return null; }
};
const record = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
);

const packageInfo = record(readJson(resolve(here, '../package.json')));
export const RELEASE_VERSION = typeof packageInfo.version === 'string' ? packageInfo.version : null;

const buildInfo = record(readJson(resolve(here, '../build-meta.json')));
const rawBuildId = typeof buildInfo.buildId === 'string' ? buildInfo.buildId : null;
export const BUILD_ID = rawBuildId && (/^[0-9a-f]{12}$/.test(rawBuildId)
  || /^sha256:[0-9a-f]{64}$/.test(rawBuildId)) ? rawBuildId : null;
const DISPLAY_BUILD_ID = BUILD_ID?.startsWith('sha256:')
  ? BUILD_ID.slice('sha256:'.length, 'sha256:'.length + 12) : BUILD_ID;

export const SERVER_VERSION = RELEASE_VERSION && BUILD_ID
  ? `${RELEASE_VERSION}+${DISPLAY_BUILD_ID}`
  : RELEASE_VERSION;
