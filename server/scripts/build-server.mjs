#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..');
const root = path.resolve(server, '..');
const out = path.join(server, 'dist');

function containsClientBuild(publicDir, expectedVersion) {
  const assets = path.join(publicDir, 'assets');
  if (!existsSync(assets)) return false;
  for (const entry of readdirSync(assets, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try {
      if (readFileSync(path.join(assets, entry.name), 'utf8').includes(expectedVersion)) return true;
    } catch { /* ignore non-text assets */ }
  }
  return false;
}

execFileSync(process.execPath, [path.join(server, 'scripts', 'write-build-meta.mjs')], {
  cwd: root,
  stdio: 'inherit',
});

let buildMeta = JSON.parse(readFileSync(path.join(server, 'build-meta.json'), 'utf8'));
const packageInfo = JSON.parse(readFileSync(path.join(server, 'package.json'), 'utf8'));
let expectedClientBuild = `${packageInfo.version}+${buildMeta.buildId}`;
const publicCandidates = [path.join(server, 'public'), path.join(root, 'web', 'dist')];
if (!publicCandidates.some((candidate) => containsClientBuild(candidate, expectedClientBuild))) {
  // A server-only build after source changes would otherwise generate a new build ID while
  // copying the previous web bundle. Rebuild the web bundle once so both halves consume the
  // same deployment identity. A normal bundle -> build:server flow takes this fast path.
  console.log(`[build-server] web bundle does not contain ${expectedClientBuild}; rebuilding it`);
  execFileSync(process.execPath, [path.join(server, 'scripts', 'bundle-web.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  buildMeta = JSON.parse(readFileSync(path.join(server, 'build-meta.json'), 'utf8'));
  expectedClientBuild = `${packageInfo.version}+${buildMeta.buildId}`;
}

rmSync(out, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [path.join(server, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', path.join(server, 'tsconfig.build.json')],
  { cwd: server, stdio: 'inherit' },
);

// Keep the public launcher path stable while the implementation itself migrates from JS to TS.
renameSync(path.join(out, 'bin', 'handmux-main.js'), path.join(out, 'bin', 'handmux.js'));

// Runtime code keeps the same relative layout inside dist: bin/, src/, connectors/, hooks/, public/ and package.json.
// This lets migration happen file-by-file without making asset lookup depend on whether a module is JS or TS.
cpSync(path.join(server, 'hooks'), path.join(out, 'hooks'), { recursive: true });

const publicSource = publicCandidates.find((candidate) => containsClientBuild(candidate, expectedClientBuild));
if (!publicSource) throw new Error(`[build-server] no web bundle matches ${expectedClientBuild}`);
cpSync(publicSource, path.join(out, 'public'), { recursive: true });

// The compiled CLI reads its adjacent package metadata for --version and update checks. Keep a generated
// copy in dist so those lookups remain deterministic in source builds and in the published tarball.
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'package.json'), `${JSON.stringify(packageInfo, null, 2)}\n`);
const buildMetaPath = path.join(server, 'build-meta.json');
if (existsSync(buildMetaPath)) cpSync(buildMetaPath, path.join(out, 'build-meta.json'));
