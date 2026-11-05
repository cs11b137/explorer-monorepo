import { concept, floatLayer, wire } from '../decode/structures';
import { addTrace, decodeFloat, encodeFloat, encodeTrace, fieldsOf } from '../sim/float';
import { pk, probe, show } from './dsl';
import type { Lesson } from './types';
import { cell, dim, fieldsCaption, floatBits, grid, hx, kv, on } from './views';

const ONE = encodeFloat(1);
const NEG_TENTH = encodeFloat(-0.1);
const traceTenth = encodeTrace(-0.1);
const TENTH = encodeFloat(0.1);
const FIFTH = encodeFloat(0.2);
const THREE_TENTHS = encodeFloat(0.3);
const add = addTrace(TENTH, FIFTH);
const BIG = encodeFloat(16777216);
const UNIT = encodeFloat(1);
const lost = addTrace(BIG, UNIT);

const short = (value: number) => (Math.abs(value) < 1e-30 || Math.abs(value) > 1e30 ? value.toExponential(6) : String(+value.toPrecision(9)));
const sigBin = (value: number) => {
  const text = Math.floor(value).toString(2).padStart(27, '0');
  return `${text.slice(0, 1)}.${text.slice(1, 24)} ${text.slice(24)}`;
};

const specials = [
  { name: '+0', bits: encodeFloat(0) },
  { name: '最小次正规', bits: 1 },
  { name: '最小规格化', bits: 0x00800000 },
  { name: '最大规格化', bits: 0x7f7fffff },
  { name: '+无穷', bits: encodeFloat(Infinity) },
  { name: 'NaN', bits: 0x7fc00000 },
];

const specialTable = grid('特殊编码：看阶码', [['', 76], ['E', 34], ['F', 66], ['类别', 62], ['值', 96]], specials.map(({ name, bits }) => {
  const f = fieldsOf(bits);
  const text = { zero: '零', subnormal: '次正规', normal: '规格化', infinity: '无穷', nan: 'NaN' }[f.kind];
  return [name, String(f.exponent), `0x${f.fraction.toString(16)}`, f.kind === 'normal' ? cell(text, 'green') : cell(text, 'amber'), short(decodeFloat(bits))];
}));

const alignTable = (trace: typeof add, title: string) => grid(title, [['', 66], ['有效数字（GRS 在最后）', 216]], [
  ['大数', sigBin(trace.bigSig)],
  [`小数 >>${trace.shift}`, cell(sigBin(trace.smallAligned), 'amber')],
  [trace.lost ? '粘滞位' : '移出', trace.lost ? on('有位被移出，S=1', 'amber') : dim('没有丢位')],
]);

const adderPanel = (trace: typeof add | null) => kv('尾数加法器', trace ? [
  ['运算', trace.subtract ? '减' : '加'],
  ['指数', `2^${trace.rawPower}`],
  ['和', `0x${Math.floor(trace.rawSum).toString(16)}`],
] : [['运算', dim('—')], ['指数', dim('—')], ['和', dim('—')]]);

const normPanel = (trace: typeof add | null) => kv('规格化和舍入', trace ? [
  ['指数', `2^${trace.normalizedPower}`],
  ['G R S', `${trace.guard} ${trace.round} ${trace.sticky}`],
  ['舍入', trace.roundedUp ? on('进 1', 'amber') : '舍去'],
] : [['指数', dim('—')], ['G R S', dim('—')], ['舍入', dim('—')]]);

const addFields = (trace: typeof add) => concept('运算过程', [
  ['指数差', String(trace.shift), `小数右移 ${trace.shift} 位`],
  ['大数有效数字', sigBin(trace.bigSig)],
  ['对齐后的小数', sigBin(trace.smallAligned), trace.lost ? '有 1 被移出，粘滞位 S 记住了它。' : '没有丢失任何位。'],
  ['和', sigBin(trace.rawSum)],
  ['规格化后', sigBin(trace.normalized), `指数 2^${trace.normalizedPower}`],
  ['G R S', `${trace.guard} ${trace.round} ${trace.sticky}`, '就近舍入、平局取偶：G=1 且 (R 或 S 或最低位) 为 1 时进位。'],
], 'amber');

export const float: Lesson = {
  id: 'float',
  name: 'FLOAT',
  title: 'IEEE 754 浮点',
  group: 'data',
  layer: [3, 5],
  clock: 'step',
  nodes: ['norm', 'rega', 'regb', 'shifter', 'adder', 'regy'],
  place: { rega: [200, 140], regb: [620, 140], shifter: [200, 320], adder: [460, 320], norm: [720, 320], regy: [720, 560] },
  labels: {
    rega: ['操作数 A', 'binary32'],
    regb: ['操作数 B', 'binary32'],
    shifter: ['对阶移位器', '小数右移'],
    adder: ['尾数加法器', '27 位'],
    norm: ['规格化与舍入', '就近舍入，平局取偶'],
    regy: ['结果寄存器', 'binary32'],
  },
  panels: { rega: [0, 0], regb: [420, 0], table: [0, 410], adder: [360, 410], norm: [530, 410], regy: [255, 582] },
  main: ['table'],
  strip: [['rega', 'regb'], 'table', 'adder', 'norm', 'regy'],
  initial: {
    rega: floatBits(0, '操作数 A', fieldsCaption(0)),
    regb: floatBits(0, '操作数 B', fieldsCaption(0)),
    table: grid('对阶', [['', 66], ['有效数字（GRS 在最后）', 216]], [['大数', dim('—')], ['小数', dim('—')], ['移出', dim('—')]]),
    adder: adderPanel(null),
    norm: normPanel(null),
    regy: floatBits(0, '结果', fieldsCaption(0)),
  },
  start: ['norm', 'rega'],
  legend: [['violet', '符号'], ['amber', '阶码与对阶'], ['teal', '尾数'], ['green', '结果'], [null, '周期列是算法步骤，延迟因实现而异']],
  overview: {
    full: '用 32 位表示很大和很小的实数',
    description: '浮点数把一个数写成二进制的科学计数法：符号、指数和有效数字各占固定的位。这一课编码 1.0 和 -0.1，再把 0.1 和 0.2 真的加一遍：对阶、相加、规格化、舍入。RV32I 基础指令集没有浮点指令，F 扩展的 fadd.s 或软件库才会走这些步骤。',
    facts: [
      ['标准', 'IEEE 754 binary32'],
      ['符号', '1 位'],
      ['阶码', '8 位，偏移 127'],
      ['尾数', '23 位，加隐藏位共 24 位有效数字'],
      ['1.0', hx(ONE)],
      ['-0.1', hx(NEG_TENTH)],
    ],
  },
  steps: [
    {
      title: '三个字段',
      desc: '1.0 = 1.0 × 2^0',
      detail: `1.0 写成二进制科学计数法是 1.0 × 2^0。符号是 0；指数 0 加上偏移 127 存成 127；规格化数的整数部分一定是 1，所以不存，这一位叫隐藏位，尾数全 0。合起来就是 ${hx(ONE)}。阶码用偏移而不用补码，这样正数可以直接按整数比较大小。`,
      facts: [['符号 S', '0'], ['阶码 E', '127 = 01111111'], ['尾数 F', '0'], ['位模式', hx(ONE)]],
      events: [
        pk('norm', 'rega', 'blue', '编码 1.0', [hx(ONE)], [1, 'ENC', `1.0 编码成 ${hx(ONE)}`, 4],
          wire('写入浮点寄存器', 'mem', 'spec', floatLayer(ONE, '1.0', 'blue', '1.0 × 2^0'))),
        probe({ rega: floatBits(ONE, '操作数 A = 1.0', fieldsCaption(ONE)) }),
      ],
    },
    {
      title: '0.1 存不准',
      desc: '循环小数被截断后要舍入',
      detail: `0.1 的二进制是 0.0001100110011… 无限循环，规格化后是 1.1001100… × 2^-4。24 位有效数字放不下，舍入位是 ${traceTenth.guard}，后面还有 1，所以向上进 1，最低位从 …100 变成 …101。这就是 -0.1 的位模式以 CD 结尾的原因，存进去的值绝对值也比 0.1 略大一点。`,
      facts: [['真实指数', '-4'], ['阶码 E', '123'], ['舍入前有效数字', `0x${traceTenth.truncated.toString(16)}`], ['舍入后', `0x${(traceTenth.truncated + 1).toString(16)}`], ['位模式', hx(NEG_TENTH)], ['实际存的值', short(decodeFloat(NEG_TENTH))]],
      events: [
        pk('norm', 'rega', 'blue', '编码 -0.1', [hx(NEG_TENTH)], [2, 'ENC', `-0.1 舍入后编码成 ${hx(NEG_TENTH)}`, 4],
          wire('写入浮点寄存器', 'mem', 'spec', floatLayer(NEG_TENTH, '-0.1', 'blue', `实际值 ${decodeFloat(NEG_TENTH)}`), concept('舍入过程', [
            ['舍入前 24 位', `0x${traceTenth.truncated.toString(16)}`],
            ['舍入位 G', String(traceTenth.guard), '第 25 位。'],
            ['粘滞位 S', String(traceTenth.sticky), '更低的位里只要有 1，这里就是 1。'],
            ['结果', traceTenth.roundedUp ? '向上进 1' : '舍去', 'G=1 且 S=1，比一半大，向上进位。'],
          ], 'amber'))),
        probe({ rega: floatBits(NEG_TENTH, '操作数 A = -0.1', fieldsCaption(NEG_TENTH)) }),
      ],
    },
    {
      title: '特殊编码',
      desc: '阶码全 0 和全 1 留作特殊用途',
      detail: '阶码全 0 表示零和次正规数，这时没有隐藏的 1，指数固定是 -126，让数值能逐渐接近 0。阶码全 1 留给无穷大和 NaN，所以规格化数的阶码只有 1 到 254。零有 +0 和 -0 两种编码，它们比较时相等。',
      facts: [['规格化阶码', '1 到 254'], ['最小次正规', short(decodeFloat(1))], ['最大规格化', short(decodeFloat(0x7f7fffff))], ['NaN', '尾数非 0，且 NaN ≠ NaN']],
      events: [
        probe({ table: specialTable, rega: floatBits(0x7f800000, '操作数 A = +无穷', fieldsCaption(0x7f800000)) }),
        pk('norm', 'rega', 'amber', '+无穷', [hx(0x7f800000)], [3, 'ENC', `溢出的结果编码成无穷大 ${hx(0x7f800000)}`, 4],
          wire('阶码全 1，尾数全 0', 'mem', 'spec', floatLayer(0x7f800000, '+无穷', 'amber'))),
        pk('norm', 'rega', 'amber', '次正规', [hx(1)], [3, 'ENC', `最小的次正规数 ${hx(1)} = 2^-149`, 4],
          wire('阶码全 0，没有隐藏位', 'mem', 'spec', floatLayer(1, '最小次正规数', 'amber', '2^-149'))),
        probe({ rega: floatBits(1, '操作数 A = 2^-149', fieldsCaption(1)) }),
      ],
    },
    {
      title: '对阶',
      desc: '小数向右移，让指数相同',
      detail: `0.1 的指数是 2^${fieldsOf(TENTH).power}，0.2 的指数是 2^${fieldsOf(FIFTH).power}。两个数要先对齐小数点才能相加，所以指数小的数右移 ${add.shift} 位。移出去的位不能直接丢掉：硬件多留 3 位，保护位 G、舍入位 R 和粘滞位 S，S 记录更低的位里有没有 1。`,
      facts: [['0.1', hx(TENTH)], ['0.2', hx(FIFTH)], ['指数差', String(add.shift)], ['丢位', add.lost ? '有，记在 S 里' : '没有，都在 GRS 里']],
      events: [
        show('regb', 'shifter', 'adder'),
        probe({ rega: floatBits(TENTH, '操作数 A = 0.1', fieldsCaption(TENTH)), regb: floatBits(FIFTH, '操作数 B = 0.2', fieldsCaption(FIFTH)), table: grid('对阶', [['', 66], ['有效数字（GRS 在最后）', 216]], [['大数', dim('—')], ['小数', dim('—')], ['移出', dim('—')]]) }),
        pk('rega', 'shifter', 'blue', '小数', ['0.1', `指数差 ${add.shift}`], [4, 'DATA', '指数较小的 0.1 送入移位器', 4],
          wire('比较阶码后选出小数', 'mem', 'spec', floatLayer(TENTH, '0.1', 'blue', `实际值 ${decodeFloat(TENTH)}`))),
        probe({ table: alignTable(add, `对阶：小数右移 ${add.shift} 位`) }),
        pk('shifter', 'adder', 'amber', '对齐后', [`右移 ${add.shift} 位`], [5, 'CALC', `小数右移 ${add.shift} 位，低位进入 GRS`, '27b'],
          wire('对阶之后', 'regs', 'model', addFields(add))),
        pk('regb', 'adder', 'blue', '大数', ['0.2'], [5, 'DATA', '指数较大的 0.2 直接送入加法器', 4],
          wire('大数不用移位', 'mem', 'spec', floatLayer(FIFTH, '0.2', 'blue', `实际值 ${decodeFloat(FIFTH)}`))),
      ],
    },
    {
      title: '相加与舍入',
      desc: '规格化，再舍入回 24 位',
      detail: `有效数字相加的结果可能到 1x.xxx，这时右移一位、指数加 1，这一步叫规格化。这次的 G R S 是 ${add.guard} ${add.round} ${add.sticky}，舍入${add.roundedUp ? '向上进 1' : '舍去'}。结果 ${hx(add.bits)} 和 0.3 的编码 ${hx(THREE_TENTHS)} ${add.bits === THREE_TENTHS ? '恰好相同' : '不同'}。binary64 里 0.1 + 0.2 不等于 0.3，说明这只是舍入碰巧相消，判断浮点数相等仍然要留余量。`,
      facts: [['和的指数', `2^${add.normalizedPower}`], ['G R S', `${add.guard} ${add.round} ${add.sticky}`], ['结果', hx(add.bits)], ['0.3 的编码', hx(THREE_TENTHS)], ['binary64', '0.1 + 0.2 ≠ 0.3']],
      events: [
        probe({ adder: adderPanel(add) }),
        pk('adder', 'norm', 'amber', '和', [`0x${Math.floor(add.rawSum).toString(16)}`], [6, 'CALC', `有效数字相加，和为 0x${Math.floor(add.rawSum).toString(16)}`, '27b'],
          wire('尾数加法器的输出', 'regs', 'model', addFields(add))),
        probe({ norm: normPanel(add) }),
        show('regy'),
        pk('norm', 'regy', 'green', '结果', [hx(add.bits), short(decodeFloat(add.bits))], [7, 'WB', `规格化并舍入，结果 ${hx(add.bits)}`, 4],
          wire('写回浮点寄存器', 'mem', 'spec', floatLayer(add.bits, '0.1 + 0.2', 'green', `实际值 ${decodeFloat(add.bits)}`), floatLayer(THREE_TENTHS, '对比：0.3', 'slate', `实际值 ${decodeFloat(THREE_TENTHS)}`))),
        probe({ regy: floatBits(add.bits, `结果 = ${short(decodeFloat(add.bits))}`, fieldsCaption(add.bits)) }),
      ],
    },
    {
      title: '精度极限',
      desc: '2^24 + 1 加不进去',
      detail: `binary32 只有 24 位有效数字。2^24 + 1 要 25 位才能精确表示，对阶时 1 右移 ${lost.shift} 位，只剩 G 位是 1，这正好是一半；就近舍入平局取偶，结果还是 2^24。所以用 float 给大数不断加 1，加到 16777216 就不再变了。这种循环在真实程序里会变成死循环。`,
      facts: [['2^24', hx(BIG)], ['指数差', String(lost.shift)], ['G R S', `${lost.guard} ${lost.round} ${lost.sticky}`], ['结果', `${hx(lost.bits)} = ${decodeFloat(lost.bits)}`]],
      events: [
        probe({ rega: floatBits(UNIT, '操作数 A = 1', fieldsCaption(UNIT)), regb: floatBits(BIG, '操作数 B = 2^24', fieldsCaption(BIG)), adder: adderPanel(lost), table: alignTable(lost, `对阶：小数右移 ${lost.shift} 位`), norm: normPanel(lost) }),
        pk('rega', 'shifter', 'blue', '1', [`右移 ${lost.shift} 位`], [8, 'DATA', `1 对阶时右移 ${lost.shift} 位`, 4],
          wire('小数', 'mem', 'spec', floatLayer(UNIT, '1', 'blue', '1 × 2^0'))),
        pk('norm', 'regy', 'green', '结果不变', [hx(lost.bits), String(decodeFloat(lost.bits))], [9, 'WB', `2^24 + 1 舍入后还是 ${decodeFloat(lost.bits)}`, 4],
          wire('写回', 'mem', 'spec', floatLayer(lost.bits, '2^24 + 1', 'green', `舍入后 ${decodeFloat(lost.bits)}`), addFields(lost))),
        probe({ regy: floatBits(lost.bits, `结果 = ${decodeFloat(lost.bits)}`, fieldsCaption(lost.bits)) }),
      ],
    },
  ],
  outro: {
    title: '有限的位，无限的实数',
    desc: '每次运算都可能舍入',
    text: '浮点数在 0 附近很密，越大越稀疏：2^24 以上相邻两个 binary32 差 2。舍入误差会在长计算里累积，所以比较时要留余量，算钱要用整数或十进制类型。',
    facts: [['有效数字', '24 位，约 7 位十进制'], ['舍入', '就近，平局取偶'], ['下一课', 'ALU']],
  },
};

