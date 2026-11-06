import { boothLayer, concept, instructionLayer, intLayer, registers, wire } from '../decode/structures';
import type { CellLike, PanelContent, Tone } from '../scene/widgets';
import { boothDigits, boothMul, shiftAddMul, toSigned, type BoothIteration, type BoothOp } from '../sim/arith';
import { assemble, bitString, hex32 } from '../sim/riscv';
import { note, pk, probe, show } from './dsl';
import type { Lesson, LessonEvent } from './types';
import { bitsPanel, cell, dim, grid, kv, on } from './views';

const WIDTH = 8;
const M = 7;
const Q = -6 & 0xff;
const booth = boothMul(M, Q, WIDTH);
const NEG_M = -M & 0xff;
/** 当成无符号数做移位相加，得到的是 7 × 250。 */
const unsigned = shiftAddMul(M, Q);
const digits = boothDigits(Q, WIDTH);
const [mulWord] = assemble(['mul x3, x1, x2']);
const MUL32 = Math.imul(M, -6) >>> 0;

const bin = (value: number) => bitString(value, WIDTH);
const signed = (value: number) => toSigned(value, WIDTH);
const hex16 = (value: number) => `0x${(value & 0xffff).toString(16).padStart(4, '0')}`;
const productBits = (high: number, low: number) => high * 256 + low;
const adds = booth.iterations.filter((item) => item.op !== 'none').length;
const ones = bin(Q).split('').filter((bit) => bit === '1').length;
const recoded = digits.map((digit, bit) => ({ digit, bit })).filter((item) => item.digit !== 0);

const OP_TEXT: Record<BoothOp, string> = { sub: 'A = A - M', add: 'A = A + M', none: '只移位' };
const OP_SHORT: Record<BoothOp, string> = { sub: '减 M', add: '加 M', none: '不动' };
const OP_WHY: Record<BoothOp, string> = {
  sub: '10：乘数里一串 1 从这一位开始，先减去 M × 2^i。',
  add: '01：上一位是一串 1 的最后一位，这一位把多减的补回来，加上 M × 2^i。',
  none: '00 或 11：在一串 0 或一串 1 的中间，什么也不用做。',
};
const OP_TONE: Record<BoothOp, Tone> = { sub: 'amber', add: 'green', none: 'dim' };

function regPanel(title: string, value: number, tone: 'blue' | 'teal'): PanelContent {
  return bitsPanel(title, value, WIDTH, [
    { name: '符号', hi: 7, lo: 7, tone: 'violet' },
    { name: '数值位', hi: 6, lo: 0, tone },
  ], `按补码读 = ${signed(value)}，无符号读 = ${value}`, 20);
}

/** 积寄存器：A、Q、Q-1 三段拼成 17 位。 */
function productPanel(a: number, q: number, qm1: number, caption: string): PanelContent {
  return bitsPanel('积寄存器 A : Q : Q-1', a * 2 ** (WIDTH + 1) + q * 2 + qm1, WIDTH * 2 + 1, [
    { name: 'A（高半）', hi: 16, lo: 9, tone: 'amber' },
    { name: 'Q（低半）', hi: 8, lo: 1, tone: 'teal' },
    { name: 'Q-1', short: '-1', hi: 0, lo: 0, tone: 'violet' },
  ], caption, 13);
}

function adderPanel(item: BoothIteration | null): PanelContent {
  if (!item || item.op === 'none') return kv('加减器', [['A', dim(item ? bin(item.aBefore) : '—')], ['加数', dim('—')], ['结果', dim('—')]]);
  return kv('加减器', [
    ['A', `${bin(item.aBefore)} = ${signed(item.aBefore)}`],
    ['加数', item.op === 'sub' ? cell(`-M = ${bin(NEG_M)}`, 'amber') : cell(`M = ${bin(M)}`, 'green')],
    ['结果', on(`${bin(item.aAfterOp)} = ${signed(item.aAfterOp)}`, item.op === 'sub' ? 'amber' : 'green')],
  ]);
}

function controlPanel(index: number | null): PanelContent {
  if (index === null) return kv('Booth 控制', [['Q0 Q-1', dim('—')], ['动作', dim('—')], ['拍数', `0 / ${WIDTH}`]]);
  const item = booth.iterations[index];
  return kv('Booth 控制', [
    ['Q0 Q-1', on(`${item.q0}${item.qm1}`, item.op === 'none' ? 'slate' : item.op === 'sub' ? 'amber' : 'green')],
    ['动作', item.op === 'none' ? dim(OP_TEXT.none) : cell(OP_TEXT[item.op], item.op === 'sub' ? 'amber' : 'green')],
    ['拍数', `${index + 1} / ${WIDTH}`],
  ]);
}

/** 逐拍过程表，只填到第 upto 拍（-1 表示只有初始行）。 */
function table(upto: number): PanelContent {
  const rows: CellLike[][] = [[dim('初始'), dim('—'), dim('—'), bin(0), bin(Q), '0']];
  booth.iterations.forEach((item, index) => {
    if (index > upto) {
      rows.push([String(index + 1), dim('·'), dim('·'), dim('·'), dim('·'), dim('·')]);
      return;
    }
    const tone = OP_TONE[item.op];
    const current = index === upto;
    rows.push([
      current ? on(String(index + 1), 'blue') : String(index + 1),
      tone === 'dim' ? `${item.q0}${item.qm1}` : on(`${item.q0}${item.qm1}`, tone),
      tone === 'dim' ? dim(OP_SHORT[item.op]) : cell(OP_SHORT[item.op], tone),
      cell(bin(item.a), current ? 'amber' : undefined),
      cell(bin(item.q), current ? 'teal' : undefined),
      String(item.qm1Out),
    ]);
  });
  return grid(`逐拍过程：${M} × (-6)，移位之后的值`, [['拍', 34], ['Q0 Q-1', 54], ['动作', 50], ['A', 76], ['Q', 76], ['Q-1', 34]], rows);
}

const stateBefore = (index: number) => (index === 0 ? { a: 0, q: Q, qm1: 0 } : { a: booth.iterations[index - 1].a, q: booth.iterations[index - 1].q, qm1: booth.iterations[index - 1].qm1Out });

/** 一拍：控制器看 Q0 Q-1，需要时加减器算 A 加减 M，最后三段一起算术右移。 */
function beat(index: number): LessonEvent[] {
  const item = booth.iterations[index];
  const cycle = index + 1;
  const before = stateBefore(index);
  const out: LessonEvent[] = [
    probe({ control: controlPanel(index), adder: adderPanel(null) }, 200),
    pk('regy', 'control', 'violet', 'Q0 Q-1', [`${item.q0}${item.qm1}`, OP_SHORT[item.op]], [cycle, 'CTRL', `第 ${cycle} 拍：Q0 Q-1 = ${item.q0}${item.qm1}，${OP_TEXT[item.op]}`, '2b'],
      wire(`第 ${cycle} 拍：Booth 控制读最低两位`, 'regs', 'model', boothLayer('积寄存器（这一拍开始时）', before.a, before.q, before.qm1, WIDTH, 'violet'), concept('Booth 判断', [
        ['Q0 Q-1', `${item.q0}${item.qm1}`],
        ['动作', OP_TEXT[item.op], OP_WHY[item.op]],
      ], 'violet')), { quick: true }),
  ];
  if (item.op !== 'none') {
    const sign = item.op === 'sub' ? '-' : '+';
    out.push(
      pk('control', 'adder', item.op === 'sub' ? 'amber' : 'green', OP_SHORT[item.op], [item.op === 'sub' ? 'M 取反，进位入 = 1' : 'M 直通，进位入 = 0'], [cycle, 'CTRL', `控制器让加减器做${item.op === 'sub' ? '减法' : '加法'}`, 'sig'],
        wire('加减控制信号', 'regs', 'model', concept('加减器的控制', [
          ['减法', item.op === 'sub' ? '1' : '0', '和 sub 指令一样：减法时 M 按位取反，第 0 位进位入置 1。'],
        ], item.op === 'sub' ? 'amber' : 'green')), { quick: true }),
      probe({ adder: adderPanel(item) }, 300),
      pk('adder', 'regy', item.op === 'sub' ? 'amber' : 'green', `A ${sign} M`, [`${signed(item.aBefore)} ${sign} ${M}`, `= ${signed(item.aAfterOp)}`], [cycle, 'CALC', `A = ${signed(item.aBefore)} ${sign} ${M} = ${signed(item.aAfterOp)}，写回 A`, '8b'],
        wire('加减器的输出写回 A', 'regs', 'model',
          intLayer('A', item.aBefore, WIDTH, 'blue', signed(item.aBefore)),
          intLayer(item.op === 'sub' ? '-M（M 取反加 1）' : 'M', item.op === 'sub' ? NEG_M : M, WIDTH, 'slate', item.op === 'sub' ? -M : M),
          intLayer('新的 A', item.aAfterOp, WIDTH, item.op === 'sub' ? 'amber' : 'green', signed(item.aAfterOp)))),
      probe({ regy: productPanel(item.aAfterOp, before.q, before.qm1, `第 ${cycle} 拍：${OP_TEXT[item.op]} 之后，还没移位`) }, 400),
    );
  }
  out.push(probe({ regy: productPanel(item.a, item.q, item.qm1Out, `第 ${cycle} 拍：右移之后 A = ${signed(item.a)}`), table: table(index) }, 450));
  return out;
}

const finalBits = productBits(booth.high, booth.low);
const unsignedHigh = (unsigned.product >>> 8) & 0xff;

export const multiply: Lesson = {
  id: 'multiply',
  name: 'MULTIPLY',
  title: '乘法器',
  group: 'data',
  layer: [2, 3],
  clock: 'cycle',
  nodes: ['rega', 'regb', 'adder', 'regy', 'control'],
  place: { rega: [110, 160], adder: [380, 160], regy: [380, 380], control: [110, 380], regb: [650, 380] },
  labels: {
    rega: ['被乘数 M', '8 位寄存器'],
    regb: ['乘数 Q', '装进积寄存器的低半'],
    adder: ['加减器', '补码一课的加法器'],
    regy: ['积寄存器', 'A : Q : Q-1'],
    control: ['Booth 控制', '看 Q0 和 Q-1'],
  },
  panels: { rega: [0, 20], adder: [282, 20], table: [556, 0], regb: [556, 245], control: [0, 470], regy: [262, 470] },
  main: ['table'],
  strip: [['rega', 'regb'], 'table', ['control', 'adder'], 'regy'],
  initial: {
    rega: regPanel('被乘数 M', 0, 'blue'),
    regb: regPanel('乘数 Q', 0, 'teal'),
    adder: adderPanel(null),
    regy: productPanel(0, 0, 0, '等待装入'),
    control: controlPanel(null),
    table: table(-1),
  },
  start: ['rega', 'regb', 'adder', 'regy'],
  legend: [['blue', '操作数'], ['violet', '读最低两位'], ['amber', '减 M'], ['green', '加 M'], [null, '迭代式乘法器，一拍一次，周期是示例']],
  overview: {
    full: '有符号乘法：用 Booth 算法直接乘补码',
    description: `乘法可以拆成移位和加法，但列竖式的做法把乘数当无符号数，乘数是负数时高半部分就错了。Booth 算法每拍看乘数的两位，在一串 1 的开头减、结尾加，直接得到补码的积。这一课用 8 位迭代式乘法器算 ${M} × (-6)，A、Q、Q-1 三个寄存器的每一位都由模拟器一拍一拍算出。`,
    facts: [
      ['算法', 'Radix-2 Booth'],
      ['例子', `${M} × (-6) = ${booth.product}`],
      ['宽度', '8 位乘 8 位，积 16 位'],
      ['拍数', `${WIDTH}，一拍一位`],
      ['加减次数', `${adds} 次，移位相加要 ${ones} 次`],
      ['指令', 'RV32M 的 mul、mulh'],
    ],
  },
  steps: [
    {
      title: '负的乘数',
      desc: '把 -6 当成无符号数乘，高半部分就错了',
      detail: `列竖式的移位相加把乘数当无符号数：${bin(Q)} 读作 ${Q}，${M} × ${Q} = ${unsigned.product}，16 位积是 ${hex16(unsigned.product)}。可是补码最高位的权重是 -128，不是 +128，${M} × (-6) = -42 应该是 ${hex16(finalBits)}。两者低 8 位都是 0x${booth.low.toString(16)}，差别全在高 8 位。`,
      facts: [['被乘数 M', `${bin(M)} = ${M}`], ['乘数 Q', `${bin(Q)} = -6`], ['当无符号乘', `${M} × ${Q} = ${hex16(unsigned.product)}`], ['正确的积', `-42 = ${hex16(finalBits)}`]],
      events: [
        probe({ rega: regPanel(`被乘数 M = ${M}`, M, 'blue') }),
        pk('rega', 'adder', 'blue', 'M', [bin(M), `= ${M}`], [0, 'DATA', `被乘数 M = ${M} 接到加减器`, '8b'],
          wire('被乘数寄存器', 'regs', 'model', intLayer('被乘数 M', M, WIDTH, 'blue', M))),
        probe({ regb: regPanel('乘数 Q = -6', Q, 'teal') }),
        pk('regb', 'regy', 'blue', 'Q', [bin(Q), '= -6'], [0, 'DATA', `乘数 ${bin(Q)} 装进积寄存器的低半，A 和 Q-1 清零`, '8b'],
          wire('装入乘数', 'regs', 'model', intLayer('乘数 Q', Q, WIDTH, 'teal', -6), boothLayer('积寄存器（初始）', 0, Q, 0))),
        probe({ regy: productPanel(0, Q, 0, 'A = 0，Q = 乘数，Q-1 = 0') }, 600),
        note('regb', `当无符号数读是 ${Q}`, 'amber'),
      ],
    },
    {
      title: 'Booth 规则',
      desc: '看 Q0 和 Q-1，决定减、加还是不动',
      detail: `每拍看乘数最低位 Q0 和上一拍移出的 Q-1：10 表示一串 1 从这里开始，A 减去 M；01 表示一串 1 刚结束，A 加上 M；00 和 11 不动。然后 A、Q、Q-1 连在一起算术右移一位，A 的符号位复制到最高位。第 1 拍是 00，只移位；第 2 拍是 10，A = 0 - ${M} = ${signed(booth.iterations[1].aAfterOp)}，右移后是 ${signed(booth.iterations[1].a)}。`,
      facts: [['10', OP_TEXT.sub], ['01', OP_TEXT.add], ['00 和 11', '不动'], ['然后', 'A : Q : Q-1 算术右移 1 位']],
      events: [show('control'), ...beat(0), ...beat(1)],
    },
    {
      title: '一串 1 的两头',
      desc: '01 加回来，10 再减',
      detail: `第 3 拍是 01：乘数里第 1 位的那串 1 只有一位，到这里结束，A 加回 ${M}。第 4 拍又是 10，从第 3 位开始的一串 1 开头，A 再减 ${M}。减法用的是补码一课的加法器：M 按位取反，进位入置 1。`,
      facts: [['第 3 拍', `01，A = ${signed(booth.iterations[2].aBefore)} + ${M} = ${signed(booth.iterations[2].aAfterOp)}`], ['第 4 拍', `10，A = ${signed(booth.iterations[3].aBefore)} - ${M} = ${signed(booth.iterations[3].aAfterOp)}`], ['-M', `${bin(NEG_M)}`]],
      events: [...beat(2), ...beat(3)],
    },
    {
      title: '高位的 1 不用算',
      desc: '11 只移位，符号位自己补齐',
      detail: `-6 的第 3 到第 7 位全是 1，Booth 把这一整串看成「从第 3 位起减 8」，后面 4 拍都是 11，只移位。算术右移把 A 的符号位一路复制下去，负的部分积一直保持为负。移位相加要为乘数里的 ${ones} 个 1 各加一次，Booth 只做了 ${adds} 次加减。`,
      facts: [['第 5 到 8 拍', '11，只移位'], ['加减次数', `${adds} 次`], ['移位相加', `${ones} 次加法`], ['A 的最高位', '一直是 1']],
      events: [...beat(4), ...beat(5), ...beat(6), ...beat(7)],
    },
    {
      title: '积',
      desc: `${WIDTH} 拍得到 16 位的 -42`,
      detail: `${WIDTH} 拍后 A : Q = ${bin(booth.high)} ${bin(booth.low)} = ${hex16(finalBits)}，按补码读是 ${booth.product}。Booth 相当于把 -6 重写成第 ${recoded.map((item) => item.bit).join('、')} 位分别为 ${recoded.map((item) => (item.digit > 0 ? '+1' : '-1')).join('、')} 的数，${recoded.map((item, i) => (i === 0 ? String(item.digit * 2 ** item.bit) : `${item.digit > 0 ? '+' : '-'} ${2 ** item.bit}`)).join(' ')} = -6，所以符号自然算对了。RV32M 的 mul 只取低 32 位，有符号和无符号结果相同；取高 32 位的 mulh 和 mulhu 才要区分，这里高 8 位一个是 0x${booth.high.toString(16)}，一个是 0x${unsignedHigh.toString(16).padStart(2, '0')}。真实处理器用 Radix-4 Booth 把部分积减半，再用加法树几拍内加完，不会一位一位地迭代。`,
      facts: [['A : Q', `${hex16(finalBits)} = ${booth.product}`], ['重编码', digits.slice().reverse().map((digit) => (digit > 0 ? '+1' : digit < 0 ? '-1' : '0')).join(' ')], ['mul（低半）', '有无符号一样'], ['mulh / mulhu', `高半 0x${booth.high.toString(16)} / 0x${unsignedHigh.toString(16).padStart(2, '0')}`]],
      events: [
        probe({ table: table(WIDTH - 1), control: controlPanel(WIDTH - 1) }, 500),
        pk('regy', 'control', 'green', '完成', [`${WIDTH} 拍`, hex16(finalBits)], [WIDTH, 'CTRL', `计数到 ${WIDTH}，A : Q = ${hex16(finalBits)} = ${booth.product}`, '16b'],
          wire('积寄存器', 'regs', 'model', boothLayer('积（A : Q）', booth.high, booth.low, booth.iterations[WIDTH - 1].qm1Out, WIDTH, 'green'), concept('Booth 重编码', digits.map((digit, bit): [string, string, string?] => [`第 ${bit} 位`, digit > 0 ? '+1' : digit < 0 ? '-1' : '0', digit ? `${digit > 0 ? '加' : '减'} ${M} × ${2 ** bit}` : undefined]), 'violet'))),
        note('regy', `${M} × (-6) = ${booth.product}`, 'green'),
        pk('regy', 'control', 'green', 'mul', [hex32(MUL32)], [WIDTH, 'WB', `换成 32 位的 mul x3, x1, x2：x3 = ${hex32(MUL32)}`, 'reg'],
          wire('mul x3, x1, x2', 'regs', 'spec', instructionLayer(mulWord, { text: 'mul x3, x1, x2' }), registers('32 位时', [['x1', M], ['x2', -6 >>> 0, '-6 的 32 位补码。'], ['x3', MUL32, '积的低 32 位，就是 -42。']], 'green')), { quick: true }),
      ],
    },
  ],
  outro: {
    title: '减法换来符号',
    desc: '一串 1 只在两头各算一次',
    text: 'Booth 把乘数里连续的 1 换成一次减法加一次加法，补码的负权重也就自然算进去了。同一个加减器、一组移位寄存器，就能做有符号乘法。下一课看小数怎样用浮点表示。',
    facts: [['规则', '10 减、01 加'], ['移位', '算术右移'], ['下一课', 'FLOAT']],
  },
};
