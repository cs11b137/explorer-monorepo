import { concept, fullAdderLayer, intLayer, wire } from '../decode/structures';
import type { GridWidget, PanelContent } from '../scene/widgets';
import { negateSteps, rippleAdd, rippleSub, toSigned, type AddResult } from '../sim/arith';
import { bitString } from '../sim/riscv';
import { note, pk, probe, show } from './dsl';
import type { Lesson, LessonEvent } from './types';
import { bitsPanel, cell, dim, grid, kv, on } from './views';

const WIDTH = 8;
const bin = (value: number) => bitString(value, WIDTH);

function intPanel(title: string, value: number, tone: 'blue' | 'teal' | 'green' = 'blue'): PanelContent {
  return bitsPanel(title, value, WIDTH, [
    { name: '符号', hi: 7, lo: 7, tone: 'violet' },
    { name: '数值位', hi: 6, lo: 0, tone },
  ], `按补码读 = ${toSigned(value, WIDTH)}，无符号读 = ${value & 0xff}`, 20);
}

/** 行波进位加法器逐位画出来，只显示已经算到 done 位的结果。 */
function adderPanel(result: AddResult | null, done: number, title = '行波进位加法器'): GridWidget {
  const cols: Array<[string, number]> = [['第几位', 50]];
  for (let bit = WIDTH - 1; bit >= 0; bit--) cols.push([String(bit), 30]);
  const row = (name: string, pick: (bit: NonNullable<AddResult>['bits'][number]) => string, gated: boolean, tone?: 'green' | 'amber') => {
    const cells: Array<string | ReturnType<typeof cell>> = [name];
    for (let bit = WIDTH - 1; bit >= 0; bit--) {
      if (!result) cells.push(dim('·'));
      else if (gated && bit >= done) cells.push(dim('·'));
      else {
        const text = pick(result.bits[bit]);
        cells.push(tone && text === '1' ? on(text, tone) : text);
      }
    }
    return cells;
  };
  return grid(title, cols, [
    row('A', (b) => String(b.a), false),
    row('B', (b) => String(b.b), false),
    row('进位入', (b) => String(b.cin), true, 'amber'),
    row('和 S', (b) => String(b.sum), true, 'green'),
    row('进位出', (b) => String(b.cout), true, 'amber'),
    row('稳定时刻', (b) => String(b.coutAt), true),
  ]);
}

function flagsPanel(result: AddResult | null, done = true): PanelContent {
  if (!result || !done) return kv('溢出检测', [['有符号溢出', dim('—')], ['进位出', dim('—')]]);
  return kv('溢出检测', [
    ['有符号溢出', result.overflow ? on('是', 'red') : cell('否', 'green')],
    ['进位出', result.carryOut ? on('1', 'amber') : '0'],
  ]);
}

const negate3 = negateSteps(3);
const A = 5;
const B = negate3.negated;
const sum = rippleAdd(A, B);
const SUB_A = 12;
const SUB_B = 7;
const sub = rippleSub(SUB_A, SUB_B);
const OVER_A = 100;
const OVER_B = 50;
const over = rippleAdd(OVER_A, OVER_B);

const LAST_CARRY = sum.bits[WIDTH - 1].coutAt;
/** 门延迟是每次运算各自从 0 算起的；为了让轨迹表单调，这里接在上一次运算之后。 */
const T_NEG = 0;
const T_ADD = T_NEG + 2;
const T_SUB = T_ADD + LAST_CARRY + 1;
const T_OVER = T_SUB + LAST_CARRY + 1;

const ripple: LessonEvent[] = sum.bits.slice(1).flatMap((bit): LessonEvent[] => [
  probe({ adder: adderPanel(sum, bit.bit + 1) }, 120),
  pk('adder', 'regy', bit.cout ? 'amber' : 'green', `第 ${bit.bit} 位`, [`${bit.a}+${bit.b}+${bit.cin} → S=${bit.sum} C=${bit.cout}`],
    [T_ADD + bit.sumAt, 'CALC', `第 ${bit.bit} 位：${bit.a}+${bit.b}+进位${bit.cin}，和 ${bit.sum}，${bit.cout ? `向第 ${bit.bit + 1} 位进 1` : '不进位'}`, '1b'],
    wire(`加法器第 ${bit.bit} 位`, 'regs', 'model', fullAdderLayer(bit)), { quick: true }),
  probe({ regy: intPanel('结果寄存器 Y（算到这一位）', sum.bits.slice(0, bit.bit + 1).reduce((acc, item) => acc + (item.sum << item.bit), 0), 'green') }, 260),
]);

export const integer: Lesson = {
  id: 'integer',
  name: 'INTEGER',
  title: '补码与加法器',
  group: 'data',
  layer: [2, 3],
  clock: 'gate',
  nodes: ['rega', 'regb', 'adder', 'regy', 'flags'],
  place: { rega: [150, 150], regb: [600, 150], adder: [375, 300], regy: [650, 340], flags: [110, 340] },
  labels: {
    rega: ['寄存器 A', '第一个操作数'],
    regb: ['寄存器 B', '第二个操作数'],
    adder: ['行波进位加法器', '8 个全加器串联'],
    regy: ['寄存器 Y', '结果'],
    flags: ['溢出检测', '教学用，RV32I 没有'],
  },
  panels: { rega: [30, 0], regb: [490, 0], adder: [195, 395], regy: [525, 436], flags: [0, 436] },
  main: ['adder'],
  strip: [['rega', 'regb', 'regy', 'flags'], 'adder'],
  initial: {
    rega: intPanel('寄存器 A', 3),
    regb: intPanel('寄存器 B', 0, 'teal'),
    adder: adderPanel(null, 0),
    regy: intPanel('寄存器 Y', 0, 'green'),
    flags: flagsPanel(null),
  },
  start: ['rega', 'adder', 'regb'],
  legend: [['blue', '操作数'], ['green', '和'], ['amber', '进位'], ['violet', '符号位'], [null, '周期列是门延迟：一个门算 1 个']],
  overview: {
    full: '计算机用同一个加法器做加法和减法',
    description: `计算机把负数存成补码，于是有符号和无符号的加法可以共用一个电路。这一课用 8 位演示（RV32I 是 32 位，原理相同）：把 -3 变成补码，再看 ${A} + (-3) 的进位怎样一位一位传过去。结构图上每一位的进位都会实时点亮。`,
    facts: [
      ['表示法', 'n 位补码'],
      ['8 位范围', '-128 到 127'],
      ['最高位权重', '-2^7 = -128'],
      ['加法器', '全加器串联'],
      ['8 位最长路径', `${sum.delay} 个门延迟`],
      ['平台', 'RISC-V RV32I'],
    ],
  },
  steps: [
    {
      title: '补码',
      desc: '按位取反再加 1，得到负数',
      detail: `-3 的补码是 3 按位取反再加 1：${bin(negate3.original)} → ${bin(negate3.inverted)} → ${bin(negate3.negated)}。这样存的好处是最高位的权重直接是 -128，-128 + 125 = -3，加法电路不用区分正负。常见的说法「最高位是符号，其余位是绝对值」说的是原码，补码的其余位不是绝对值。`,
      facts: [['3', bin(negate3.original)], ['按位取反', bin(negate3.inverted)], ['再加 1', bin(negate3.negated)], ['按权重算', '-128 + 125 = -3']],
      events: [
        probe({ rega: intPanel('寄存器 A = 3', negate3.original) }),
        pk('rega', 'adder', 'blue', '取反', [`~${bin(negate3.original)}`, `= ${bin(negate3.inverted)}`], [T_NEG, 'CALC', `把 3 按位取反，得到 ${bin(negate3.inverted)}`, '8b'],
          wire('A 经过反相器', 'regs', 'model', intLayer('3', negate3.original, WIDTH, 'blue', 3), intLayer('按位取反', negate3.inverted, WIDTH, 'slate', toSigned(negate3.inverted, WIDTH)))),
        note('adder', '进位入 = 1，也就是再加 1'),
        pk('adder', 'regb', 'green', '加 1', [`= ${bin(negate3.negated)}`, '= -3'], [T_NEG + 1, 'CALC', `取反后加 1，得到 -3 的补码 ${bin(negate3.negated)}`, '8b'],
          wire('写入寄存器 B', 'regs', 'model', intLayer('-3 的补码', negate3.negated, WIDTH, 'green', -3))),
        probe({ regb: intPanel('寄存器 B = -3', B, 'teal') }),
      ],
    },
    {
      title: '第 0 位',
      desc: '一个全加器算一位',
      detail: `现在算 ${A} + (-3)。全加器有 3 个输入：A 的一位、B 的一位和低一位来的进位。和是三者的异或；进位在「两个输入都是 1」或「有一个是 1 且进位入是 1」时产生。第 0 位是 1 + 1 + 0，和为 0，向第 1 位进 1。`,
      facts: [['A', `${bin(A)} = ${A}`], ['B', `${bin(B)} = -3`], ['S', 'p XOR Cin'], ['Cout', 'g OR (p AND Cin)']],
      events: [
        probe({ rega: intPanel(`寄存器 A = ${A}`, A), adder: adderPanel(sum, 0) }),
        pk('rega', 'adder', 'blue', 'A', [bin(A)], [T_ADD, 'DATA', `A = ${A} 送入加法器`, '8b'], wire('操作数 A', 'regs', 'model', intLayer('A', A, WIDTH, 'blue', A)), { quick: true }),
        pk('regb', 'adder', 'blue', 'B', [bin(B)], [T_ADD, 'DATA', 'B = -3 送入加法器', '8b'], wire('操作数 B', 'regs', 'model', intLayer('B', B, WIDTH, 'blue', -3)), { quick: true }),
        show('regy'),
        probe({ adder: adderPanel(sum, 1) }, 120),
        pk('adder', 'regy', 'amber', '第 0 位', [`1+1+0 → S=${sum.bits[0].sum} C=${sum.bits[0].cout}`], [T_ADD + sum.bits[0].sumAt, 'CALC', '第 0 位：1+1+进位0，和 0，向第 1 位进 1', '1b'],
          wire('加法器第 0 位', 'regs', 'model', fullAdderLayer(sum.bits[0]))),
        probe({ regy: intPanel('结果寄存器 Y（算到这一位）', sum.bits[0].sum, 'green') }),
      ],
    },
    {
      title: '进位传播',
      desc: '进位一位一位往高位走',
      detail: `第 1 位要等第 0 位的进位，第 2 位要等第 1 位，所以叫行波进位。每过一位多等 2 个门（一个与门、一个或门）。8 位最坏 ${LAST_CARRY} 个门延迟，32 位最坏 65 个。时钟周期要按最坏情况来定，所以真实 CPU 常用超前进位等结构把它缩短。`,
      facts: [['每位多等', '2 个门延迟'], ['8 位最长', `${LAST_CARRY} 个门延迟`], ['32 位最长', `${rippleAdd(0, 0, 0, 32).bits[31].coutAt} 个门延迟`], ['结果', `${bin(sum.sum)} = ${toSigned(sum.sum, WIDTH)}`]],
      events: [
        ...ripple,
        note('regy', `${A} + (-3) = ${toSigned(sum.sum, WIDTH)}`, 'green'),
      ],
    },
    {
      title: '减法',
      desc: 'A - B = A + ~B + 1，同一个加法器',
      detail: `sub 指令不需要单独的减法器。把 B 按位取反，再把第 0 位的进位入置 1，就等于加上 -B。RV32I 的 add 和 sub 只差 inst[30] 这一位，这一位正好可以接到取反器和进位入上。这里算 ${SUB_A} - ${SUB_B}，最高位的进位出是 ${sub.carryOut}：无符号减法里它为 1 表示没有借位。`,
      facts: [['A', `${bin(SUB_A)} = ${SUB_A}`], ['~B', bin(~SUB_B & 0xff)], ['进位入', '1'], ['结果', `${bin(sub.sum)} = ${sub.sum}`]],
      events: [
        probe({ rega: intPanel(`寄存器 A = ${SUB_A}`, SUB_A), regb: intPanel(`寄存器 B = ${SUB_B}`, SUB_B, 'teal'), adder: adderPanel(sub, 0, `${SUB_A} - ${SUB_B}：B 取反，进位入 = 1`) }),
        pk('regb', 'adder', 'blue', '~B', [`~${bin(SUB_B)}`, `= ${bin(~SUB_B & 0xff)}`], [T_SUB, 'CALC', `sub：B = ${SUB_B} 取反，第 0 位进位入置 1`, '8b'],
          wire('减法时 B 经过反相器', 'regs', 'model', intLayer('B', SUB_B, WIDTH, 'blue', SUB_B), intLayer('~B', ~SUB_B & 0xff, WIDTH, 'slate', toSigned(~SUB_B, WIDTH)))),
        probe({ adder: adderPanel(sub, WIDTH, `${SUB_A} - ${SUB_B}：B 取反，进位入 = 1`) }, 500),
        pk('adder', 'regy', 'green', '差', [`${bin(sub.sum)} = ${sub.sum}`], [T_SUB + sub.delay, 'CALC', `${SUB_A} - ${SUB_B} = ${sub.sum}，进位出 ${sub.carryOut}`, '8b'],
          wire('减法结果', 'regs', 'model', intLayer('差', sub.sum, WIDTH, 'green', toSigned(sub.sum, WIDTH)), fullAdderLayer(sub.bits[WIDTH - 1]))),
        probe({ regy: intPanel(`结果寄存器 Y = ${sub.sum}`, sub.sum, 'green') }),
      ],
    },
    {
      title: '溢出',
      desc: '结果超出范围时位串回绕',
      detail: `${OVER_A} + ${OVER_B} = 150 超出了 8 位有符号的上限 127，位串 ${bin(over.sum)} 按补码读是 ${toSigned(over.sum, WIDTH)}。判断方法是看最高位：进位入和进位出不同就是有符号溢出。RISC-V 没有标志寄存器，加法也不会触发异常；要检查溢出得自己写指令，比如无符号加法后用 bltu 比较结果和操作数。`,
      facts: [['位串', bin(over.sum)], ['有符号读', String(toSigned(over.sum, WIDTH))], ['无符号读', String(over.sum)], ['溢出判断', `第 7 位进位入 ${over.bits[7].cin} ≠ 进位出 ${over.bits[7].cout}`], ['RISC-V', '无标志位，软件自己检查']],
      events: [
        show('flags'),
        probe({ rega: intPanel(`寄存器 A = ${OVER_A}`, OVER_A), regb: intPanel(`寄存器 B = ${OVER_B}`, OVER_B, 'teal'), adder: adderPanel(over, WIDTH, `${OVER_A} + ${OVER_B}`) }, 500),
        pk('adder', 'regy', 'green', '和', [`${bin(over.sum)}`, `读作 ${toSigned(over.sum, WIDTH)}`], [T_OVER + over.delay, 'CALC', `${OVER_A} + ${OVER_B} 回绕成 ${toSigned(over.sum, WIDTH)}`, '8b'],
          wire('溢出的结果', 'regs', 'model', intLayer('和', over.sum, WIDTH, 'green', toSigned(over.sum, WIDTH)))),
        probe({ regy: intPanel('结果寄存器 Y', over.sum, 'green') }),
        pk('adder', 'flags', 'violet', '第 7 位', [`进位入 ${over.bits[7].cin}`, `进位出 ${over.bits[7].cout}`], [T_OVER + over.delay, 'CALC', '第 7 位的进位入和进位出不同：有符号溢出', '1b'],
          wire('最高位', 'regs', 'model', fullAdderLayer(over.bits[7]), concept('溢出判断', [
            ['V = C7入 XOR C7出', over.overflow ? '1' : '0', '只对有符号数有意义。'],
            ['C = C7出', String(over.carryOut), '只对无符号数有意义。这里 100 + 50 没有超过 255，所以是 0。'],
          ], 'violet'))),
        probe({ flags: flagsPanel(over) }),
      ],
    },
  ],
  outro: {
    title: '一个电路，三种用途',
    desc: '加法、减法和比较都走同一条进位链',
    text: '补码让硬件不用区分有符号和无符号的加法，只有比较、右移和符号扩展才需要区分。这也是 RV32I 有 slt 和 sltu、sra 和 srl、lb 和 lbu 两套指令，却只有一条 add 的原因。',
    facts: [['加法', 'add'], ['减法', 'sub = A + ~B + 1'], ['溢出', '进位入 ≠ 进位出'], ['下一课', 'FLOAT']],
  },
};
