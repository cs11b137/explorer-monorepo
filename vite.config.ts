import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { protocolMirror } from './scripts/protocol-mirror';

const ROOT = import.meta.dirname;
const PORT = 5300;
// 部署到子路径时由环境变量指定，比如 /explorer-monorepo/。本地开发在根路径。
const BASE = process.env.BASE_PATH ?? '/';

// 带 index.html 的模块都参与构建，地址就是目录路径。Protocol 是镜像，由 protocolMirror 处理。
const pages = readdirSync(resolve(ROOT, 'modules'))
  .map((name) => `modules/${name}/index.html`)
  .filter((page) => existsSync(resolve(ROOT, page)));

/** modules/os 重定向到 modules/os/。多页面模式下，不带斜杠的目录地址不会找到 index.html。 */
function moduleTrailingSlash(): Plugin {
  const pattern = new RegExp(`^${BASE}modules/[^/.]+$`);
  const redirect: Connect.NextHandleFunction = (req, res, next) => {
    const [path, query] = (req.url ?? '').split(/(?=\?)/);
    if (!pattern.test(path)) return next();
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
  base: BASE,
  appType: 'mpa',
  server: { port: PORT, strictPort: true },
  preview: { port: PORT, strictPort: true },
  optimizeDeps: { entries: ['index.html', ...pages] },
  build: {
    target: 'es2022',
    // 基路径下的 assets/ 留给 Protocol 镜像。
    assetsDir: 'static',
    // 404.html 放在输出根目录。Cloudflare Pages 没有它时，会把不存在的地址都返回首页。
    rollupOptions: { input: ['index.html', '404.html', ...pages].map((page) => resolve(ROOT, page)) },
  },
  plugins: [moduleTrailingSlash(), protocolMirror(ROOT)],
});
