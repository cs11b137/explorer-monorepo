// 把 Protocol Explorer 镜像接入主站。
//
// 镜像的页面和代码都用根路径引用资源（/assets/…、/favicon.svg），放到子路径就会找不到。
// 所以页面放在 modules/protocol/，其余资源放在站点基路径下。
// site/ 本身永远不动。基路径是 / 时原样提供；部署到子路径时，只在输出的副本里给这些根路径加上前缀。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

const PAGE_DIR = 'modules/protocol';
/** 这些文件不被页面引用，或者只对作者的线上地址有意义，不占用主站的基路径。 */
const PAGE_FILES = new Set(['/index.html', '/robots.txt', '/sitemap.xml']);
/** Vite 生成的预加载函数，决定语言包这类动态依赖从哪里加载。 */
const PRELOAD = /function\((\w+)\)\{return"\/"\+\1\}/;

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

/** 镜像文件相对基路径的地址。 */
export function mirrorUrl(path: string): string {
  return PAGE_FILES.has(path) ? `/${PAGE_DIR}${path}` : path;
}

/** 给镜像文件里的根路径加上基路径。基路径是 / 时返回原字节。 */
export function rewriteMirror(path: string, bytes: Buffer, base: string): Buffer {
  if (base === '/') return bytes;
  const text = () => bytes.toString('utf8');
  switch (extname(path)) {
    case '.html':
      return Buffer.from(text().replace(/\b(href|src)="\/(?!\/)/g, `$1="${base}`));
    case '.css':
      return Buffer.from(text().replace(/url\((["']?)\/(?!\/)/g, `url($1${base}`));
    case '.webmanifest':
      return Buffer.from(text().replace(/("(?:src|start_url|scope)":\s*")\//g, `$1${base}`));
    case '.js':
      return PRELOAD.test(text()) ? Buffer.from(text().replace(PRELOAD, `function($1){return"${base}"+$1}`)) : bytes;
    default:
      return bytes;
  }
}

export function protocolMirror(root: string): Plugin {
  const site = resolve(root, PAGE_DIR, 'site');
  const manifest = JSON.parse(readFileSync(resolve(root, PAGE_DIR, 'MANIFEST.json'), 'utf8')) as { files: Array<{ path: string }> };
  const files = manifest.files.map((file) => file.path);
  const byUrl = new Map(files.map((path) => [mirrorUrl(path), path]));
  let base = '/';
  const read = (path: string) => rewriteMirror(path, readFileSync(join(site, path)), base);

  return {
    name: 'protocol-mirror',
    configResolved(config) {
      base = config.base;
    },
    buildStart() {
      for (const path of files) {
        if (!PAGE_FILES.has(path) && existsSync(join(root, 'public', path))) {
          this.error(`public${path} 和 Protocol 镜像占用了同一个路径`);
        }
      }
      // 重新镜像后，如果预加载函数变了样，语言包会全部 404。这里直接失败，不要部署一个坏站。
      const preloads = files.filter((path) => extname(path) === '.js' && PRELOAD.test(readFileSync(join(site, path), 'utf8')));
      if (preloads.length !== 1) this.error(`Protocol 镜像里应该只有一个预加载函数，实际找到 ${preloads.length} 个`);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const full = req.url?.split('?')[0] ?? '';
        if (!full.startsWith(base)) return next();
        const url = `/${full.slice(base.length)}`;
        const path = byUrl.get(url === `/${PAGE_DIR}/` ? `/${PAGE_DIR}/index.html` : url);
        if (!path) return next();
        res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
        res.end(read(path));
      });
    },
    writeBundle(options) {
      const outDir = options.dir ?? resolve(root, 'dist');
      for (const [url, path] of byUrl) {
        const target = join(outDir, url);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, read(path));
      }
    },
  };
}
