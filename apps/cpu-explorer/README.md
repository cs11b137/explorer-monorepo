# CPU Explorer

用交互动画讲解计算机组成原理，把部件里的当前值直接画在结构图上，并逐位解码指令、浮点数和地址。14 节课涵盖补码与加法器、IEEE 754、ALU、RV32I 指令编码、单周期数据通路、控制单元、五级流水线、数据冒险与前递、分支预测、组相联缓存、写策略、MESI、DRAM 时序和 DMA。

平台基准是 RISC-V RV32I、经典 5 级流水线和 IEEE 754 binary32。缓存和 DRAM 的参数是教学示例，真实处理器的数值标 E.G.。

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

- `src/sim/`：真实的实现。RV32I 编码器和解码器、周期精确的流水线、2 位预测器、组相联缓存、MESI、DRAM 时序、总线和 DMA、IEEE 754、门级加法器。课程里的数值全部由它们算出。
- `src/lessons/`：每节课一个文件，把模拟器的结果变成事件序列。
- `src/decode/`：按真实布局写字节和位的字段写入器和各结构定义。
- `src/scene/`：等距场景、设备图形和数值面板（`widgets.ts`）。
- 时钟、播放器、场景、界面和基础样式都在 `packages/engine`，本站的配置在 `src/site.ts`。

## 独立核对

`tests/fixtures/` 里的向量不是被测代码算出来的：

- `rv32i-llvm.json`：535 行汇编文本和 LLVM 汇编器产出的指令字，覆盖全部基础指令和 B、J 型的边界偏移。
- `rv32i-unicorn.json`：课程程序和 40 个随机程序在 Unicorn（QEMU 派生）上跑完的寄存器和内存。单周期 CPU 和流水线（开关前递、带预测器）都要跑出相同结果。
- 浮点用 `Float32Array` 对照，加法用 `Float32Array` 的结果比较 3 万组随机向量。

重新生成向量用 `tests/fixtures/gen_golden.py`，需要 `pip install ziglang unicorn`。本机的 Apple clang 不带 RISC-V 后端，所以用 `zig cc`（自带 clang）。

## 增加一节课

在 `src/lessons/` 新建文件并加入 `src/lessons/index.ts`。`tests/lessons.test.ts` 会自动检查节点显示顺序、周期单调、字段范围、面板尺寸，以及通道和面板是否穿过设备。
