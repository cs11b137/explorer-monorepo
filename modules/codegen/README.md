# Codegen Explorer

看懂源代码如何变成机器码。用交互动画讲解编译原理，一小段 C 程序贯穿 14 节课：词法、语法、类型检查、LLVM IR、活跃分析、SSA、优化、循环外提、指令选择、寄存器分配、栈帧、x86-64 编码、ELF 链接。

课程以 C 语言子集、LLVM IR、x86-64 System V、ELF64 为基准。结构图上显示的产物（源码高亮、token 流、语法树、LR 栈和表、CFG、IR 文本、寄存器分配表、机器码字节、ELF 布局）都由 `src/compiler/` 里的小编译器现场算出，没有手写结果。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。

## 开发

本模块由主站统一提供服务，地址是 `/modules/codegen/`。启动和构建都在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test           # 本模块的单元测试
npm run vectors    # 用本机工具重新生成 tests/vectors（需要 clang、llvm-objdump、bison、Rosetta）
```

## 结构

- `src/compiler/`：真实的小编译器。词法器（表驱动 DFA）、递归下降解析器、SLR 表生成器、语义分析、IR 生成、数据流分析、SSA 构造、SCCP、DCE、LICM、指令选择、线性扫描、帧布局、x86-64 编码器、ELF 写入器和链接器。
- `src/lessons/`：每节课一个文件。事件和产物视图都由编译结果生成。
- `src/decode/`：把真实字节解码成检查器字段：指令的 REX/ModRM/SIB，ELF 头、节头、符号表项、重定位项。
- `src/scene/`：等距场景、设备图形和产物面板（`art.ts` 是纯函数，事件序列折叠后重画）。
- 时钟、播放器、场景、界面和基础样式都在 `packages/engine`，本模块的配置在 `src/site.ts`。

## 独立核对

`tests/vectors/` 存着本机工具的输出，单元测试拿它们当标准答案：

| 产物 | 对照 |
| --- | --- |
| 记号 | `clang -Xclang -dump-tokens` |
| 语法树 | `clang -Xclang -ast-dump` |
| LR 自动机 | `bison -v` |
| -O0 IR | `clang -S -emit-llvm -O0 -fno-discard-value-names`，逐行相同 |
| SSA、优化后 IR | `clang -O1 -mllvm -print-after=sroa` |
| 循环外提 | `clang -O1 -mllvm -print-after=licm` |
| 编码器 | 指令矩阵由 clang 汇编，`llvm-objdump` 读回，逐字节相同 |
| 目标文件 | 同一段汇编由 clang 汇编，整个 .o 逐字节相同 |
| 链接结果 | `llvm-objdump -d` 反汇编映像 |
| 语义 | 各阶段 IR 和最终机器码在 Rosetta 下运行，结果和 C 源码相同 |

本机没有 ELF 链接器，链接结果只核对过地址，没有运行。

## 增加一节课

在 `src/lessons/` 新建文件并加入 `src/lessons/index.ts`。`tests/lessons.test.ts` 会自动检查节点显示顺序、字段范围、通道是否穿过设备、面板文字是否放得下。
