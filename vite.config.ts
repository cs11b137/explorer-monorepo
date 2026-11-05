import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { protocolMirror } from './scripts/protocol-mirror';

const ROOT = import.meta.dirname;
const PORT = 5300;

// 带 index.html 的模块都参与构建，地址就是目录路径。Protocol 是镜像，由 protocolMirror 处理。
const pages = readdirSync(resolve(ROOT, 'modules'))
  .map((name) => `modules/${name}/index.html`)
  .filter((page) => existsSync(resolve(ROOT, page)));

/** /modules/os 重定向到 /modules/os/。多页面模式下，不带斜杠的目录地址不会找到 index.html。 */
function moduleTrailingSlash(): Plugin {
  const redirect: Connect.NextHandleFunction = (req, res, next) => {
    const [path, query] = (req.url ?? '').split(/(?=\?)/);
    if (!/^\/modules\/[^/.]+$/.test(path)) return next();
    res.writeHead(301, { Location: `${path}/${query ?? ''}` });
    res.end();
  };
  return {
    name: 'module-trailing-slash',
    configureServer: (server) => void server.middlewares.use(redirect),
    configurePreviewServer: (server) => void server.middlewares.use(redirect),
  };
}

export default defineConfig({
  appType: 'mpa',
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
  optimizeDeps: { entries: ['index.html', ...pages] },
  build: {
    target: 'es2022',
    // 站点根路径的 assets/ 留给 Protocol 镜像。
    assetsDir: 'static',
    rollupOptions: { input: ['index.html', ...pages].map((page) => resolve(ROOT, page)) },
  },
  plugins: [moduleTrailingSlash(), protocolMirror(ROOT)],
});
