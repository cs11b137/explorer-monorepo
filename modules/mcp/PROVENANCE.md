# 来源记录

`site/` 是 [MCP Explained](https://mcp-explained.com)（作者 Runlayer）源码仓库 `public/` 目录的逐字节镜像。简体中文是本仓库加的叠加层，不改动 `site/`。

| 项目 | 内容 |
|---|---|
| 来源 | https://github.com/Runlayer/mcp-explained ，`public/` 目录 |
| 版本 | commit `9ac8b9aa3219e3fb57a8ab4927dfe92acde1777a`（2026-11-05）。文件清单、大小和 SHA-256 在 `MANIFEST.json` |
| 镜像工具 | `scripts/mirror.mjs`，从 GitHub 按 commit 下载，只下载不执行 |
| 授权 | 项目所有者于 2026-11-09 说明，已获 Runlayer 同意镜像、翻译成简体中文，并在本公开仓库、wuwenjunpr.site 和 cs-explorer.pages.dev 上发布。同意的原文未存入本仓库，建议把它放在这里 |
| 许可证 | 上游仓库没有许可证文件，这里也没有替作者添加任何许可证。简体中文译文同样没有单独授权 |
| 首页图标 | `public/modules/mcp/icon.svg` 是 `site/favicon.svg` 的同字节拷贝，给首页卡片用 |

## 这是什么

上游就是一个自包含的 `index.html`：样式、字体（base64）、课程数据和渲染器全在里面，没有构建步骤。`og.png` 和 `mcp-explained.mp4` 只被页面里指向 mcp-explained.com 的分享标签引用，一并原样镜像。页面里的 canonical、Open Graph 和 Twitter 标签仍然指向作者的线上地址，这是原样保留的。

## 中文怎么叠加上去

浏览器拿到的 `index.html` 由根目录的 `scripts/mcp-mirror.ts` 生成：在 `site/index.html` 的副本上做几处替换，开发服务器和构建用的是同一个函数 `buildPage`。

1. favicon 改成相对路径，部署到子路径也能找到。
2. 在原站的数据脚本和渲染器之间插入叠加层：字典（`i18n/zh-CN.json`、`i18n/ui.zh-CN.json`）、`src/walk.js`、`src/i18n.js`。
3. 渲染器里的界面文字换成 `__t(...)` 调用，图上文字宽度的估算换成 `__len(...)`（中文字按两个字符宽算）。补丁表是 `PATCHES`。

运行时：

- 默认简体中文。右上角的 `EN / 中文` 按钮切换语言，选择记在 `localStorage` 的 `mcp-explained:lang`；存不了时退回地址参数 `?lang=en`。切换会刷新页面，地址里的 hash（当前课、变体、规范版本）保留。
- 中文模式下，`src/walk.js` 在渲染器读取之前，把课程数据里的讲解文字就地换成中文；`src/i18n.js` 翻译页面骨架和界面文字。
- **线上报文（`json`）不翻译**，检查器里显示的 JSON-RPC 消息和原站完全一样。方法名、字段名、头名、版本号、规范关键词（MUST、SHOULD……）在译文里也保持英文。
- 英文模式下，`__t` 原样返回英文，页面除了多一个切换按钮，和原站一致。端到端测试会逐课对比英文模式和原始页面的全部文字。
- 原站的交互一点没改：布局、播放控制、快捷键、规范时间线、变体、风险弹窗、移动端底栏、hash 路由都是原样。

## 不要手改 site/

`npm test -w mcp-explained` 会逐文件校验 SHA-256，任何改动都会报错。

## 同步上游更新

1. `npm run mirror:mcp -- <commit 或分支>` 重写 `site/` 和 `MANIFEST.json`。不带参数时重新下载 `MANIFEST.json` 里记录的 commit。
2. `npm run extract -w mcp-explained -- <输出文件>` 报告字典缺失和多余的条目，并导出全部待译文字和出处。补齐 `i18n/zh-CN.json`，删掉多余的键。
3. `npm run build`。上游改了渲染器，补丁表对不上时，构建会报出具体是哪一条，按新代码调整 `PATCHES`。界面文字有新增时，补进 `i18n/ui.zh-CN.json`。
4. `npm run test:e2e -- --project=mcp`。没找到译文的文字会被记进 `window.__MCP_I18N__.misses`，测试要求它为空。
