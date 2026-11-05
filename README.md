# Explorer Monorepo

六个交互式教学站：逐事件动画 + 逐字节解码。

| 目录 | 站点 | 内容 | `npm run dev:all` 端口 |
|---|---|---|---|
| `apps/protocol-explorer` | Protocol Explorer | 网络协议。作者 Dilum Sanjaya 线上站的镜像，见其 `PROVENANCE.md` | 5300 |
| `apps/os-explorer` | OS EXPLORER | 操作系统 | 5301 |
| `apps/algo-explorer` | ALGO EXPLORER | 数据结构与算法 | 5302 |
| `apps/codegen-explorer` | CODEGEN EXPLORER | 编译原理 | 5303 |
| `apps/cpu-explorer` | CPU EXPLORER | 计算机组成原理 | 5304 |
| `apps/db-explorer` | DB EXPLORER | 数据库系统原理 | 5305 |
| `packages/engine` | `@explorer/engine` | 后五个站共用的引擎 | |

## 常用命令

```bash
npm install
npm run dev:all          # 同时启动全部站点
npm run dev:cpu          # 只启动一个
npm run typecheck
npm test                 # 全部单元测试，并校验 Protocol Explorer 镜像
npm run test:e2e         # 全部端到端测试，只测 Chromium
npm run build
npm run mirror:protocol  # 从线上重新镜像 Protocol Explorer
```

## 引擎和站点怎么分工

引擎（`packages/engine/src`）负责所有站都一样的部分：

- `app.ts`：组装界面、快捷键
- `core/`：动画时钟、时间线播放器、进度存储、响应式布局
- `scene/iso.ts`、`scene/stage.ts`：等距图元，结构图场景（节点、通道、相机、事件动画）
- `ui/`：顶栏、课程列表、轨迹表、时序图、概览、检查器
- `decode/writer.ts`：按字节写结构、字段联动
- `styles/`：颜色令牌和全部基础样式

每个站（`apps/*/src`）只放自己的内容：

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

## 新增一个站

1. 复制一个结构最接近的站到 `apps/<name>-explorer`，改 `package.json` 的名字和端口。
2. 改 `src/site.ts`，把存储前缀、品牌、标签页、7 档色块换掉；`public/theme-init.js` 里的存储键要和前缀一致。
3. 写 `lessons/`、`scene/devices.ts`。引擎的事件不够用时，在 `scene/plugin.ts` 里加。
4. 按新站的字符重新裁剪字体。
