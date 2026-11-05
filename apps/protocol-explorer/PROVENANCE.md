# 来源记录

`site/` 是 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)（作者 Dilum Sanjaya）线上部署产物的逐字节镜像。

| 项目 | 内容 |
|---|---|
| 来源 | https://protocol-explorer-alpha.vercel.app/ |
| 镜像工具 | `scripts/mirror.mjs`，文件清单、大小、SHA-256、ETag 和时间都在 `MANIFEST.json` |
| 授权 | 项目所有者于 2026-11-05 说明已取得作者同意。同意的原文未存入本仓库，建议把它放在这里 |
| 许可证 | 来源站没有公开的许可证文件，这里也没有替作者添加任何许可证 |

## 这是什么，不是什么

- 这是**构建产物**，不是源码。线上没有 sourcemap，也没有找到公开仓库，所以 JS 和 CSS 都是压缩后的样子，不能像源码那样维护。
- 这个站有自己的引擎，没有接入 `packages/engine`。要接入或做二次开发，需要向作者要源码。
- 页面里的 canonical、Open Graph、sitemap 仍然指向作者的线上地址。这是原样保留的；要部署到别的地址，先和作者确认。

## 不要手改 site/

`npm test -w protocol-explorer` 会逐文件校验 SHA-256，任何改动都会报错。要同步线上更新，运行 `npm run mirror:protocol`，它会重写 `site/` 和 `MANIFEST.json`。
