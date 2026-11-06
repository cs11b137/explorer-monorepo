import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { ARG_REGS, callRegs, chunkHeader, chunkSize, cString, cStruct, cStructArray, intArray, intMatrix, layoutOf, returnReg, u32Var, wire, type CField } from '../src/decode/structures';
import { decode, type Byte } from '../src/decode/writer';

const u32 = (b: Byte[], o: number) => ((b[o] as number) | ((b[o + 1] as number) << 8) | ((b[o + 2] as number) << 16) | ((b[o + 3] as number) << 24)) >>> 0;
const u64 = (b: Byte[], o: number) => BigInt(u32(b, o)) | (BigInt(u32(b, o + 4)) << 32n);

const VEC: CField[] = [['data', 'ptr'], ['len', 'size_t'], ['cap', 'size_t']];
const NODE: CField[] = [['val', 'int'], ['next', 'ptr']];
const RING: CField[] = [['buf', 'ptr'], ['cap', 'uint32_t'], ['head', 'uint32_t'], ['tail', 'uint32_t']];
const SLOT: CField[] = [['key', 'ptr'], ['value', 'int'], ['hash', 'uint32_t'], ['state', 'uint8_t']];
const AVL: CField[] = [['key', 'int'], ['height', 'int'], ['left', 'ptr'], ['right', 'ptr']];
const ITEM: CField[] = [['dist', 'int'], ['node', 'int']];
const STACK: CField[] = [['data', 'ptr'], ['top', 'int'], ['cap', 'int']];
const BST: CField[] = [['key', 'int'], ['left', 'ptr'], ['right', 'ptr']];
const EDGE: CField[] = [['u', 'int'], ['v', 'int'], ['w', 'int']];

describe('结构布局和真实编译器一致', () => {
  // 期望值抄自 tests/reference/layouts.c，由 clang -target x86_64-unknown-linux-gnu 用 _Static_assert 核对过。
  it.each([
    ['struct vec', VEC, 24, [0, 8, 16]],
    ['struct node', NODE, 16, [0, 8]],
    ['struct ring', RING, 24, [0, 8, 12, 16]],
    ['struct slot', SLOT, 24, [0, 8, 12, 16]],
    ['struct avl_node', AVL, 24, [0, 4, 8, 16]],
    ['struct pq_item', ITEM, 8, [0, 4]],
    ['struct stack', STACK, 16, [0, 8, 12]],
    ['struct bst_node', BST, 24, [0, 8, 16]],
    ['struct edge', EDGE, 12, [0, 4, 8]],
  ] as const)('%s', (_name, fields, size, offsets) => {
    const layout = layoutOf(fields as unknown as CField[]);
    expect(layout.size).toBe(size);
    expect(layout.fields.map((field) => field.offset)).toEqual(offsets);
  });

  it('填充字节的位置：node 和 bst_node 在字段中间，ring 和 slot 在尾部', () => {
    expect(layoutOf(NODE).pads).toEqual([{ offset: 4, size: 4, before: 'next' }]);
    expect(layoutOf(RING).pads).toEqual([{ offset: 20, size: 4, before: null }]);
    expect(layoutOf(SLOT).pads).toEqual([{ offset: 17, size: 7, before: null }]);
    expect(layoutOf(AVL).pads).toEqual([]);
    expect(layoutOf(ITEM).pads).toEqual([]);
    expect(layoutOf(BST).pads).toEqual([{ offset: 4, size: 4, before: 'left' }]);
    expect(layoutOf(STACK).pads).toEqual([]);
    expect(layoutOf(EDGE).pads).toEqual([]);
  });

  const hasClang = (() => {
    try {
      execFileSync('clang', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasClang)('clang 在 x86-64 Linux 目标上接受全部 _Static_assert', () => {
    execFileSync('clang', ['-target', 'x86_64-unknown-linux-gnu', '-std=c11', '-ffreestanding', '-fsyntax-only', 'tests/reference/layouts.c'], { stdio: 'pipe' });
  });
});

describe('字节级解码', () => {
  it('struct node：小端写入，填充标成内容不确定', () => {
    const layer = cStruct('struct node', NODE, { val: 0x2a, next: 0x55d0c8a012a0n });
    expect(layer.bytes).toEqual([0x2a, 0, 0, 0, null, null, null, null, 0xa0, 0x12, 0xa0, 0xc8, 0xd0, 0x55, 0, 0]);
    expect(layer.fields.map((field) => [field.name, field.from, field.to])).toEqual([['val · +0', 0, 4], ['填充 · +4', 4, 8], ['next · +8', 8, 16]]);
    expect(layer.fields[1].hidden).toBe(true);
    expect(layer.fields[2].example).toBe(true);
  });

  it('NULL 指针全 0，显示为 NULL，不算示例值', () => {
    const layer = cStruct('struct node', NODE, { val: 1, next: 0n });
    expect(u64(layer.bytes, 8)).toBe(0n);
    expect(layer.fields[2].value).toBe('NULL');
    expect(layer.fields[2].example).toBe(false);
  });

  it('struct slot：state 在 +16，尾部 7 字节填充', () => {
    const layer = cStruct('slot', SLOT, { key: 0n, value: 7, hash: 0xd01fc26d, state: 1 });
    expect(layer.length).toBe(24);
    expect(u32(layer.bytes, 8)).toBe(7);
    expect(u32(layer.bytes, 12)).toBe(0xd01fc26d);
    expect(layer.bytes[16]).toBe(1);
    expect(layer.bytes.slice(17)).toEqual(new Array(7).fill(null));
  });

  it('int 数组：元素 4 字节紧挨着，负数按补码，未初始化不写', () => {
    const layer = intArray('a', [1, -1, null]);
    expect(layer.length).toBe(12);
    expect(u32(layer.bytes, 0)).toBe(1);
    expect(u32(layer.bytes, 4)).toBe(0xffffffff);
    expect(layer.bytes.slice(8)).toEqual([null, null, null, null]);
    expect(layer.fields[2].value).toBe('未初始化');
  });

  it('二维数组按行存放：dp[1][2] 在 (1 × 3 + 2) × 4 = 20', () => {
    const layer = intMatrix('dp', [[0, 0, 0], [0, 0, 9]]);
    expect(layer.length).toBe(24);
    expect(u32(layer.bytes, 20)).toBe(9);
    expect(layer.fields[5].name).toBe('dp[1][2] · +20');
    expect([layer.fields[5].from, layer.fields[5].to]).toEqual([20, 24]);
  });

  it('结构体数组：下一个元素从 size 的整数倍开始', () => {
    const layer = cStructArray('pq', ITEM, [{ dist: 7, node: 1 }, { dist: 9, node: 2 }]);
    expect(layer.length).toBe(16);
    expect(u32(layer.bytes, 8)).toBe(9);
    expect(u32(layer.bytes, 12)).toBe(2);
    expect(layer.fields[3].name).toBe('pq[1].node · +4');
  });

  it('C 字符串末尾有 0 字节', () => {
    const layer = cString('key', 'hi');
    expect(layer.bytes).toEqual([0x68, 0x69, 0]);
  });

  it('uint32_t 小端：0x811c9dc5 的第一个字节是 c5', () => {
    expect(u32Var('h', 0x811c9dc5).bytes).toEqual([0xc5, 0x9d, 0x1c, 0x81]);
  });

  it('多层拼接后，字段偏移换算到整体坐标', () => {
    const frame = decode(wire('栈', 'mem', 'abi', cString('k', 'a'), intArray('a', [5])));
    expect(frame.bytes.length).toBe(6);
    const element = frame.fields.find((field) => field.name.startsWith('a[0]'))!;
    expect([element.from, element.to]).toEqual([2, 6]);
    expect(frame.layers[1].from).toBe(2);
  });
});

describe('System V 调用约定', () => {
  it('参数寄存器顺序', () => {
    expect(ARG_REGS).toEqual(['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9']);
    const layer = callRegs('f', [['a', 1], ['b', 2], ['c', 3], ['d', 4]]);
    expect(layer.fields.map((field) => field.name)).toEqual(['rdi', 'rsi', 'rdx', 'rcx']);
    expect(u64(layer.bytes, 24)).toBe(4n);
  });

  it('返回值放在 rax，-1 是全 1', () => {
    const layer = returnReg('f', -1, '');
    expect(layer.fields[0].name).toBe('rax');
    expect(u64(layer.bytes, 0)).toBe(0xffffffffffffffffn);
  });
});

describe('glibc malloc 块大小', () => {
  // 来自 glibc malloc.c 的 request2size 宏：MINSIZE = 32，SIZE_SZ = 8，对齐 16。
  it.each([[0, 32], [4, 32], [16, 32], [24, 32], [25, 48], [32, 48], [40, 48], [41, 64]])('malloc(%i) 占 %i 字节', (request, size) => {
    expect(chunkSize(request)).toBe(size);
  });

  it('块头低位是 PREV_INUSE', () => {
    expect(u64(chunkHeader(16).bytes, 0)).toBe(0x21n);
    expect(u64(chunkHeader(32).bytes, 0)).toBe(0x31n);
  });
});
