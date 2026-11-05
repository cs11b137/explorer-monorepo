# ALGO Explorer

用交互动画讲解数据结构与算法，并逐字节解码真实的内存布局。14 节课涵盖动态数组、链表、环形队列、哈希表、二分查找、二叉堆、AVL 树、并查集、BFS、Dijkstra、快速排序、归并排序、动态规划和 KMP。

平台基准是 C 语言、x86-64、LP64、小端，结构布局按 System V ABI 计算。所有轨迹都由课程文件里的真实算法跑出来，结构图直接显示数据结构当前的样子。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。

## 开发

```sh
npm install          # 在 monorepo 根目录运行一次
npm run dev        # 本地开发
npm run build      # 类型检查并构建到 dist/
npm test           # 单元测试
npm run test:e2e   # 端到端测试（需要 Playwright 的 Chromium）
```

## 结构

- `src/lessons/`：每节课一个文件，里面是真正的算法，由它的钩子产生事件序列。
- `src/decode/`：按真实布局写字节的字段写入器；`structures.ts` 实现了 System V 的结构布局规则。
- `src/scene/`：等距场景。`ds.ts` 把数组、树、图、表格、环形缓冲和调用栈画成等距图元，`devices.ts` 是程序、分配器和哈希函数的设备图形。
- 时钟、播放器、场景、界面和基础样式都在 `packages/engine`，本站的配置在 `src/site.ts`。
- `tests/reference/`：独立参考。`layouts.c` 用 clang 的 `_Static_assert` 核对结构偏移，`reference.c` 是不共享代码的 C 实现，测试里的期望值抄自它的输出。

## 增加一节课

在 `src/lessons/` 新建文件并加入 `src/lessons/index.ts`。写算法时留好钩子，在钩子里生成事件，每个事件带上此刻的数据结构（`ds`）和字节结构（`wire`）。`tests/lessons.test.ts` 会自动检查节点显示顺序、操作数单调、字段范围、通道和数据结构是否重叠。
