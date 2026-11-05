// 把 Protocol Explorer 镜像接入主站。
//
// 镜像必须逐字节不变，而它的页面和代码都用根路径引用资源（/assets/…、/favicon.svg），
// 放到子路径就会找不到。所以不改写文件：页面放在 /modules/protocol/，其余资源放在站点根路径。
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

const PAGE_DIR = 'modules/protocol';
/** 这些文件不被页面引用，或者只对作者的线上地址有意义，不占用主站的根路径。 */
const PAGE_FILES = new Set(['/index.html', '/robots.txt', '/sitemap.xml']);

const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
};

export function protocolMirror(root: string): Plugin {
  const site = resolve(root, PAGE_DIR, 'site');
  const manifest = JSON.parse(readFileSync(resolve(root, PAGE_DIR, 'MANIFEST.json'), 'utf8')) as { files: Array<{ path: string }> };
  const files = manifest.files.map((file) => file.path);
  const urlOf = (path: string) => (PAGE_FILES.has(path) ? `/${PAGE_DIR}${path}` : path);
  const sources = new Map(files.map((path) => [urlOf(path), join(site, path)]));

  return {
    name: 'protocol-mirror',
    buildStart() {
      for (const path of files) {
        if (!PAGE_FILES.has(path) && existsSync(join(root, 'public', path))) {
          this.error(`public${path} 和 Protocol 镜像占用了同一个根路径`);
        }
      }
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const source = sources.get(url === `/${PAGE_DIR}/` ? `/${PAGE_DIR}/index.html` : url);
        if (!source) return next();
        res.setHeader('Content-Type', TYPES[extname(source)] ?? 'application/octet-stream');
        createReadStream(source).pipe(res);
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? resolve(root, 'dist');
      for (const [url, source] of sources) {
        const target = join(outDir, url);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      }
    },
  };
}
