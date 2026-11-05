# OS Explorer

用交互动画讲解操作系统原理，并逐字节解码真实的底层结构。14 节课涵盖启动、系统调用、进程、中断、调度、锁、页表、缺页、写时复制、页面置换、文件读取、日志和管道。

课程内容以 Linux 6.12 LTS、x86-64 为基准，并对照内核源码核实。

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

- `src/lessons/`：每节课一个文件，只有数据，没有界面逻辑。
- `src/decode/`：按真实布局写字节的字段写入器和各结构定义。
- `src/scene/`：等距场景和设备图形。
- 时钟、播放器、场景、界面和基础样式都在 `packages/engine`，本站的配置在 `src/site.ts`。

## 增加一节课

在 `src/lessons/` 新建文件并加入 `src/lessons/index.ts`。`tests/lessons.test.ts` 会自动检查节点显示顺序、时间单调、字段范围和通道是否穿过其他设备。
