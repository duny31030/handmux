import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPackage = JSON.parse(readFileSync(path.resolve(here, '../server/package.json'), 'utf8'));
const buildMetaPath = path.resolve(here, '../server/build-meta.json');
const devApiPort = Number(process.env.HANDMUX_DEV_API_PORT || 9999);
const devWebPort = Number(process.env.HANDMUX_DEV_WEB_PORT || 9010);
const devApiHost = process.env.HANDMUX_DEV_API_HOST || '127.0.0.1';
const devApiTargetHost = devApiHost.includes(':') && !devApiHost.startsWith('[')
  ? `[${devApiHost}]` : devApiHost;
const devApiOrigin = `http://127.0.0.1:${devApiPort}`;
const appName = process.env.HANDMUX_APP_NAME?.trim() || null;

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
let buildMeta = null;
try {
  const value = JSON.parse(readFileSync(buildMetaPath, 'utf8'));
  if (value && typeof value === 'object' && typeof value.buildId === 'string') buildMeta = value;
} catch { /* direct Vite dev/build before metadata generation keeps the plain version */ }
const clientVersion = typeof serverPackage.version === 'string' ? serverPackage.version : '0.0.0';
const rawBuildId = typeof buildMeta?.buildId === 'string' ? buildMeta.buildId : null;
const clientBuildId = rawBuildId && /^[0-9a-f]{12}$/.test(rawBuildId)
  ? rawBuildId : rawBuildId && /^sha256:[0-9a-f]{64}$/.test(rawBuildId)
    ? rawBuildId.slice('sha256:'.length, 'sha256:'.length + 12) : null;
const clientServerVersion = clientBuildId
  ? `${clientVersion}+${clientBuildId}`
  : clientVersion;

function resolveMigratedTypeScript() {
  return {
    name: 'resolve-migrated-typescript',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/^\.\.?\/.*\.jsx?$/.test(source)) return null;
      const extensions = source.endsWith('.jsx') ? ['.tsx'] : ['.ts', '.tsx'];
      for (const extension of extensions) {
        const candidate = path.resolve(
          path.dirname(importer.split('?')[0]),
          source.replace(/\.jsx?$/, extension),
        );
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

// Make the bundled app stylesheet non-render-blocking. By default Vite emits a plain
// <link rel="stylesheet"> in <head>, which blocks the FIRST paint until that ~48KB CSS finishes
// downloading — over the tunnel that delay is long enough that Android dismisses its native PWA splash
// before our inline boot splash has painted, leaving a transparent window that shows the (blurred)
// home-screen wallpaper. Loading the CSS with media="print" + onload swap lets the inline splash (its
// styles live in index.html's <head>) paint on frame one; the app CSS arrives in parallel, well before
// the much larger JS bundle finishes and React mounts, so there's no flash of unstyled content.
function asyncAppCss() {
  return {
    name: 'async-app-css',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link rel="stylesheet"([^>]*)>/g,
        (_m, attrs) =>
          `<link rel="stylesheet"${attrs} media="print" onload="this.media='all'">` +
          `<noscript><link rel="stylesheet"${attrs}></noscript>`,
      );
    },
  };
}

// Vite serves the source HTML directly during development, so the API server's
// runtime app-name rewrite does not run. Keep the dev entry's browser tab,
// splash, and install label in sync with HANDMUX_APP_NAME instead.
function appNameShell() {
  return {
    name: 'app-name-shell',
    apply: 'serve',
    transformIndexHtml(html) {
      if (!appName) return html;
      const escaped = escapeHtml(appName);
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${escaped}</title>`)
        .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, `$1${escaped}$2`);
    },
    configureServer(server) {
      if (!appName) return;
      server.middlewares.use((req, res, next) => {
        let pathname;
        try { pathname = new URL(req.url || '/', 'http://vite.local').pathname; } catch { return next(); }
        if (pathname !== '/manifest.webmanifest') return next();
        try {
          const manifest = JSON.parse(readFileSync(path.resolve(here, 'public/manifest.webmanifest'), 'utf8'));
          manifest.name = appName;
          manifest.short_name = appName;
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/manifest+json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify(manifest));
        } catch { next(); }
      });
    },
  };
}

export default defineConfig({
  define: {
    __HANDMUX_CLIENT_VERSION__: JSON.stringify(clientServerVersion),
  },
  plugins: [resolveMigratedTypeScript(), react(), appNameShell(), asyncAppCss()],
  server: {
    host: true,
    port: devWebPort, // 开发前端(vite dev)监听端口；API 端口可由 HANDMUX_DEV_API_PORT 覆盖
    proxy: {
      // 只指向开发后端而非生产；dev.sh 会注入 9998，单独运行 Vite 时默认 9999。
      // 用 127.0.0.1(而非 localhost)强制 IPv4,避免 localhost 先解析到 ::1 与后端绑定的
      // 0.0.0.0(IPv4) 不匹配导致代理 ECONNREFUSED。
      // 开发 API 只监听 loopback。重写 Origin 让后端的 origin protection 把代理请求视为
      // API 入口；浏览器仍然只接触 Vite 的开发入口，不会把生产 API 混进来。
      '/api': { target: `http://${devApiTargetHost}:${devApiPort}`, changeOrigin: true, headers: { origin: devApiOrigin } },
      '/ws': { target: `ws://${devApiTargetHost}:${devApiPort}`, ws: true, changeOrigin: true, headers: { origin: devApiOrigin } },
    },
  },
  test: {
    environment: 'jsdom',
    // Component tests carry JSX, so they're named .test.jsx (plain logic tests stay .test.js).
    include: ['test/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.test.{js,jsx,ts,tsx}'],
    setupFiles: ['./test/setup.js'],
    // React warnings are test failures, not harmless stderr. This keeps async state updates from
    // silently drifting back outside act() while the suite still reports green.
    onConsoleLog(log) {
      if (/^Warning:/m.test(log)) throw new Error(`Unexpected test warning:\n${log}`);
    },
  },
});
