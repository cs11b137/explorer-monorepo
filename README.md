# Explorer

交互式教学主站：逐事件动画 + 逐字节解码。首页是课程入口，六门课程是主站下的模块，全部由一个服务提供。

线上地址：<https://wuwenjunpr.site/explorer-monorepo/>，<https://cs-explorer.pages.dev/>

| 目录 | 模块 | 内容 | 地址 |
|---|---|---|---|
| `index.html`、`src/`、`public/` | 主站首页 | 课程入口 | `/` |
| `modules/protocol` | Protocol Explorer | 网络协议。作者 Dilum Sanjaya 线上站的镜像，见其 `PROVENANCE.md` | `/modules/protocol/` |
| `modules/os` | OS EXPLORER | 操作系统 | `/modules/os/` |
| `modules/algo` | ALGO EXPLORER | 数据结构与算法 | `/modules/algo/` |
| `modules/codegen` | CODEGEN EXPLORER | 编译原理 | `/modules/codegen/` |
| `modules/cpu` | CPU EXPLORER | 计算机组成原理 | `/modules/cpu/` |
| `modules/db` | DB EXPLORER | 数据库系统原理 | `/modules/db/` |
| `packages/engine` | `@explorer/engine` | 后五个模块共用的引擎 | |

## 常用命令

```bash
npm install
npm run dev              # 启动主站，http://localhost:5300/
npm run build            # 类型检查、校验镜像，构建到 dist/
npm start                # 用一个服务提供 dist/，端口同样是 5300
npm run typecheck
npm test                 # 全部单元测试，并校验 Protocol Explorer 镜像
npm run test:e2e         # 全部端到端测试，只测 Chromium，按线上的子路径构建
npm run test:e2e -- --project=cpu   # 只测一个模块，主站首页的项目名是 portal
npm run mirror:protocol  # 从线上重新镜像 Protocol Explorer
```

## 主站和模块怎么组合

每个模块是一个独立页面（多页面应用），课程之间跳转会整页加载，引擎的全局状态不会互相影响。`vite.config.ts` 自动把 `modules/*/index.html` 加入构建，模块地址就是它的目录路径。

- 所有模块同源，`localStorage` 靠各自的存储前缀隔开，前缀不能重复。
- 模块的静态文件（图标、manifest、`theme-init.js`）在 `public/modules/<name>/`。
- 基路径下的 `assets/`、`favicon.svg` 等归 Protocol 镜像所有，主站的构建产物放在 `static/`。详见 `modules/protocol/PROVENANCE.md`。
- 站点可以部署在子路径下，所以模块和首页里不要写死 `/` 开头的导航地址：HTML 里的页面链接用相对路径，代码里用 `import.meta.env.BASE_URL`。

## 部署

推送到 `main` 后，两个工作流会各自构建并发布：

| 工作流 | 目标 | 基路径 |
|---|---|---|
| `.github/workflows/deploy.yml` | GitHub Pages，<https://wuwenjunpr.site/explorer-monorepo/> | `/<仓库名>/` |
| `.github/workflows/deploy-cloudflare.yml` | Cloudflare Pages，<https://cs-explorer.pages.dev/> | `/` |

- 域名 `wuwenjunpr.site` 配在 `cs11b137.github.io` 仓库上，本仓库作为项目站自动挂在它的子路径下，所以不需要 CNAME 文件。改仓库名会改变这个地址。
- Cloudflare 部署需要仓库的两个 Secrets：`CLOUDFLARE_API_TOKEN`（权限 Cloudflare Pages: Edit、Account Settings: Read）和 `CLOUDFLARE_ACCOUNT_ID`。Pages 项目名写在工作流里。

## 引擎和站点怎么分工

引擎（`packages/engine/src`）负责所有站都一样的部分：

- `app.ts`：组装界面、快捷键
- `core/`：动画时钟、时间线播放器、进度存储、响应式布局
- `scene/iso.ts`、`scene/stage.ts`：等距图元，结构图场景（节点、通道、相机、事件动画）
- `ui/`：顶栏、课程列表、轨迹表、时序图、概览、检查器
- `decode/writer.ts`：按字节写结构、字段联动
- `styles/`：颜色令牌和全部基础样式

每个模块（`modules/*/src`）只放自己的内容：

- `site.ts`：站点配置，契约见引擎的 `site.ts`
- `lessons/`：课程和事件类型
- `decode/`：可信度标签和结构解码
- `scene/devices.ts`：节点图形
- `scene/plugin.ts`：可选，站点专属的场景扩展（数据结构图元、产物面板、数值面板、结构板）
- `styles/fonts.css`、`assets/fonts/`：按本站字符裁剪的 Iosevka 子集。各站字符集差别很大，所以不共用
- `styles/site.css`：可选，相对引擎的样式差异，在引擎样式之后加载

## 改引擎时要注意

引擎的改动会影响五个站。`stage.ts` 的默认行为不要随便动：所有动画共用一个时钟，多排一个哪怕是空的等待任务，后面动画的时间量化都会变。

样式层叠也要留意：`site.css` 在引擎样式之后加载，所以它和引擎里同优先级的规则冲突时会胜出，包括响应式规则。站点要改只在宽屏生效的规则时，选择器要写窄，比如 `.is-stacked:not(.is-single) .workspace`。

## 新增一个模块

1. 复制一个结构最接近的模块到 `modules/<name>`，改 `package.json` 的名字；复制 `public/modules/<name>/`，改里面的路径；`index.html` 里的资源路径也要改。
2. 改 `src/site.ts`，把存储前缀、品牌、标签页、7 档色块换掉；`theme-init.js` 里的存储键要和前缀一致。
3. 写 `lessons/`、`scene/devices.ts`。引擎的事件不够用时，在 `scene/plugin.ts` 里加。
4. 按新站的字符重新裁剪字体。
5. 在根目录 `index.html` 加课程卡片，在 `playwright.config.ts` 和 `e2e/portal.spec.ts` 的模块列表里加上它。
