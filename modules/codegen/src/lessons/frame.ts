import { concept, instruction, makeLayer, wire } from '../decode/structures';
import { hex } from '../decode/writer';
import { MAIN, SCALE_OBJ, SUM } from '../compiler';
import { interpret } from '../compiler/interp';
import type { PlacedLine } from '../compiler/emit';
import { encode, fmtIns, r32, RBP, RDI, REG64, type Ins } from '../compiler/x86';
import type { ArtView, CodeLine, Tone } from '../scene/art';
import { note, pk, seal, show } from './dsl';
import type { Lesson, PacketEvent } from './types';

const lines = SUM.back.assembled.lines;
const scaleLines = SCALE_OBJ.funcs[0].back.assembled.lines;
const frameInfo = SUM.back.lowered.frame;

/** 示例地址：进入函数时 rsp ≡ 8 (mod 16)，这是 ABI 的要求。具体值换一次运行就会变。 */
const ENTRY_RSP = 0x7fffffffe008;
const CALLER_RBP = 0x7fffffffe030;
const CALLER_RBX = 0x1234;
const CALLER_RET = 0x401234;
const N = 5;
const run = interpret(SUM.licm.fn, [N], MAIN.module, { scale: (value) => value * 2 });
const S_VALUE = run.globals.get('total')!;

interface Cell { addr: number; value: string; note: string; tone: Tone }

class Machine {
  rsp = ENTRY_RSP + 8;
  rbp = CALLER_RBP;
  regs: Record<string, string> = { edi: String(N), ebx: hex(CALLER_RBX), eax: '?' };
  cells: Cell[] = [];

  push(value: number, what: string, tone: Tone): void {
    this.rsp -= 8;
    this.cells.push({ addr: this.rsp, value: hex(value), note: what, tone });
  }

  pop(): void {
    this.cells = this.cells.filter((cell) => cell.addr !== this.rsp);
    this.rsp += 8;
  }

  /** 真的执行一条序言或尾声里的栈操作。 */
  exec(ins: Ins, callerRet = 0): void {
    if (ins.m === 'push') {
      if (ins.r.n === RBP) this.push(this.rbp, `调用者的 rbp`, 'blue');
      else this.push(CALLER_RBX, `调用者的 ${REG64[ins.r.n]}`, 'violet');
    } else if (ins.m === 'pop') {
      if (ins.r.n === RBP) this.rbp = Number(this.cells.find((cell) => cell.addr === this.rsp)!.value);
      this.pop();
    } else if (ins.m === 'mov' && 'n' in ins.d && 'n' in ins.s && ins.d.wide) {
      this.rbp = this.rsp;
    } else if (ins.m === 'sub' && 'imm' in ins.s) {
      for (let at = 0; at < ins.s.imm; at += 8) {
        this.rsp -= 8;
        this.cells.push({ addr: this.rsp, value: '未使用', note: '对齐填充', tone: 'slate' });
      }
    } else if (ins.m === 'add' && 'imm' in ins.s) {
      for (let at = 0; at < ins.s.imm; at += 8) this.pop();
    } else if (ins.m === 'call') {
      this.push(callerRet, '返回地址', 'amber');
    } else if (ins.m === 'ret') {
      this.pop();
    }
  }
}

const machine = new Machine();

const SLOTS = 8;
const pointers = (m: Machine, top: number) => {
  const list: Array<{ name: string; at: number; tone: Tone }> = [{ name: `rsp`, at: Math.round((top - m.rsp) / 8), tone: 'amber' }];
  if (m.rbp <= top && m.rbp >= top - (SLOTS - 1) * 8) list.push({ name: 'rbp', at: Math.round((top - m.rbp) / 8), tone: 'blue' });
  return list;
};

const TOP = ENTRY_RSP + 8;

function frameView(m: Machine, sub?: string): ArtView {
  const cells = Array.from({ length: SLOTS }, (_, index) => {
    const addr = TOP - index * 8;
    const cell = m.cells.find((item) => item.addr === addr);
    const offset = addr - ENTRY_RSP;
    const label = offset === 0 ? '入口' : offset > 0 ? `入口+${offset}` : `入口-${-offset}`;
    if (index === 0) return { offset: label, value: '调用者的栈帧', dim: true };
    return cell ? { offset: label, value: cell.value, note: cell.note, tone: cell.tone } : { offset: label, value: '', dim: true };
  });
  const aligned = m.rsp % 16 === 0;
  return { kind: 'frame', title: '调用栈', sub: sub ?? `rsp mod 16 = ${m.rsp % 16}${aligned ? '，已对齐' : ''}`, cells, pointers: pointers(m, TOP) };
}

function regTable(m: Machine): ArtView {
  return {
    kind: 'table',
    title: '寄存器',
    sub: `调用 sum(${N})`,
    cols: ['寄存器', '值', '说明'],
    widths: [64, 124, 238],
    rows: [
      { cells: ['rsp', hex(m.rsp), '栈顶，地址是示例值'], tones: [null, 'amber' as Tone, null] },
      { cells: ['rbp', hex(m.rbp), '帧基址，地址是示例值'], tones: [null, 'blue' as Tone, null] },
      { cells: ['edi', m.regs.edi, '第 1 个参数'] },
      { cells: ['ebx', m.regs.ebx, '被调用者保存'] },
      { cells: ['eax', m.regs.eax, '返回值'] },
    ],
    size: 12,
  };
}

const offsetOf = (line: PlacedLine) => line.offset.toString(16).padStart(2, '0');

function asmView(active: string | null, tone: Tone = 'amber'): ArtView {
  const body: CodeLine[] = lines.map((line) => ({
    text: line.text,
    gutter: offsetOf(line),
    tone: line.text === active ? tone : undefined,
    dim: line.group === 'body' && line.text !== active && !line.ins.m.startsWith('call') && line.ins.m !== 'ret',
  }));
  return { kind: 'code', title: 'sum 的汇编', sub: `${lines.length} 条指令`, lines: body, size: 12.5, focus: Math.max(body.findIndex((line) => line.tone), 0) };
}

const find = (text: string) => lines.find((line) => line.text === text)!;

function stepOf(line: PlacedLine, label: string, payload: string, why: string, callerRet = 0): PacketEvent {
  const beforeRsp = machine.rsp;
  machine.exec(line.ins, callerRet);
  const delta = machine.rsp - beforeRsp;
  const snapshot = cloneMachine(machine);
  const pop = line.ins.m === 'pop' || line.ins.m === 'ret' || line.ins.m === 'add';
  return pk(pop ? 'frame' : 'regalloc', pop ? 'regalloc' : 'frame', pop ? 'green' : 'amber', label, [payload], [6, 'FRAME', `${line.text}：${why}${delta ? `（rsp ${delta > 0 ? '+' : ''}${delta}）` : ''}`, line.enc.bytes.length],
    wire(`sum+${hex(line.offset)} 的指令`, 'mem', 'spec', instruction(line, pop ? 'green' : 'amber')), {
      art: { frame: frameView(snapshot), asm: asmView(line.text, pop ? 'green' : 'amber'), regs: regTable(snapshot) },
    });
}

function cloneMachine(m: Machine): Machine {
  const copy = new Machine();
  copy.rsp = m.rsp;
  copy.rbp = m.rbp;
  copy.regs = { ...m.regs };
  copy.cells = m.cells.map((cell) => ({ ...cell }));
  return copy;
}

const entryState = new Machine();
const initial = { frame: frameView(entryState, '调用 sum 之前'), asm: asmView(null), regs: regTable(entryState) };

// 第 1 步：调用者的 call 压入返回地址。
machine.push(CALLER_RET, '返回地址', 'amber');
const enterEvent = (() => {
  const snapshot = cloneMachine(machine);
  const layer = makeLayer('栈上 8 字节 · 返回地址', 'amber', `地址 ${hex(ENTRY_RSP)}`);
  layer.field('返回地址', hex(CALLER_RET), () => layer.u64(CALLER_RET), { example: true, note: 'call 指令压入的下一条指令地址。具体值取决于调用者。' });
  return pk('regalloc', 'frame', 'amber', '进入 sum', ['返回地址入栈'], [6, 'FRAME', `调用者 call sum：压入返回地址，rsp mod 16 = ${ENTRY_RSP % 16}`, 8],
    wire('调用者的 call 写到栈上的 8 字节', 'mem', 'spec', layer), { art: { frame: frameView(snapshot), regs: regTable(snapshot), asm: asmView(null) } });
})();

const pushRbp = stepOf(find('push rbp'), 'push rbp', '保存调用者的帧基址', '先存调用者的 rbp');
const movRbp = stepOf(find('mov rbp, rsp'), 'mov rbp, rsp', 'rbp 指向帧底', '帧基址定在这里');
const pushRbx = stepOf(find('push rbx'), 'push rbx', '保存被调用者保存寄存器', 'ebx 被 %n 占用，要先把旧值存好');
const subRsp = stepOf(find(`sub rsp, ${frameInfo.localBytes}`), `sub rsp, ${frameInfo.localBytes}`, '补齐到 16 字节', '让 call 时 rsp 对齐到 16');
const alignedRsp = machine.rsp;

machine.regs.ebx = String(N);
const movEbx = stepOf(find('mov ebx, edi'), 'mov ebx, edi', 'n 进 ebx', '把参数挪到不会被 call 破坏的地方');

machine.regs.edi = String(S_VALUE);
const callLine = find('call scale@PLT');
const retAddr = 0x401000 + callLine.offset + callLine.enc.bytes.length;
const callEvent = stepOf(callLine, 'call scale', [`实参 edi = ${S_VALUE}`][0], `s = ${S_VALUE} 已在 edi，压入返回地址并跳转`, retAddr);

/** scale 自己也有序言和尾声，真实地跑一遍。 */
const scalePush = scaleLines.find((line) => line.text === 'push rbp')!;
machine.exec(scalePush.ins);
machine.rbp = machine.rsp;
const inScale = cloneMachine(machine);
const scaleEvent = pk('regalloc', 'frame', 'violet', 'scale 的帧', ['push rbp'], [6, 'FRAME', 'scale 的序言：push rbp，mov rbp, rsp，不需要对齐填充', scalePush.enc.bytes.length],
  wire('scale+0x0 的指令', 'mem', 'spec', instruction(scalePush, 'violet')), { quick: true, art: { frame: frameView(inScale, '在 scale 里') , regs: regTable(inScale) } });
const scalePop = scaleLines.find((line) => line.text === 'pop rbp')!;
machine.exec(scalePop.ins);
const scaleRet = scaleLines.find((line) => line.text === 'ret')!;
machine.exec(scaleRet.ins);
machine.regs.eax = String(S_VALUE * 2);
const backSnapshot = cloneMachine(machine);
const returnEvent = pk('frame', 'regalloc', 'green', '回到 sum', [`eax = ${S_VALUE * 2}`], [6, 'FRAME', `scale 返回：eax = ${S_VALUE * 2}，ebx 还是 ${N}（被调用者保存）`, scaleRet.enc.bytes.length],
  wire('scale 的 ret', 'mem', 'spec', instruction(scaleRet, 'green')), { art: { frame: frameView(backSnapshot, '回到 sum'), regs: regTable(backSnapshot), asm: asmView('add eax, ebx', 'green') } });

machine.regs.eax = String(run.value);
const addEax = stepOf(find('add eax, ebx'), 'add eax, ebx', `eax = ${run.value}`, `${S_VALUE * 2} + ${N} = ${run.value}，正是 sum(${N}) 的结果`);

const addRsp = stepOf(find(`add rsp, ${frameInfo.localBytes}`), `add rsp, ${frameInfo.localBytes}`, '撤销填充', '回到 push rbx 之后的位置');
machine.regs.ebx = hex(CALLER_RBX);
const popRbx = stepOf(find('pop rbx'), 'pop rbx', '恢复 rbx', '调用者的值原样还回去');
const popRbp = stepOf(find('pop rbp'), 'pop rbp', '恢复 rbp', '调用者的帧基址还回去');
const retEvent = stepOf(find('ret'), 'ret', '跳回调用者', '弹出返回地址');

// 对照 -O0：每个 alloca 一个槽。
const slotOrder = SUM.o0.blocks[0].insts.flatMap((inst) => (inst.op === 'alloca' ? [inst.dst] : []));
const slotOffsets = slotOrder.map((name, index) => ({ name: name.replace(/\.addr$/, ''), offset: -4 * (index + 1) }));
const O0_FRAME = Math.ceil((slotOrder.length * 4) / 16) * 16;
const O0_STORE: Ins = { m: 'mov', d: { base: RBP, disp: slotOffsets[0].offset }, s: r32(RDI) };
const o0Line = { text: fmtIns(O0_STORE), enc: encode(O0_STORE), offset: 4, jump: null, reloc: null };

const o0View = (): ArtView => ({
  kind: 'frame',
  title: '-O0 的栈帧',
  sub: `sub rsp, ${O0_FRAME}，全部变量在内存`,
  cells: [
    { offset: 'rbp+8', value: '返回地址', tone: 'amber' },
    { offset: 'rbp+0', value: '调用者的 rbp', tone: 'blue' },
    ...slotOffsets.map((slot) => ({ offset: `rbp${slot.offset}`, value: slot.name, note: '4 字节', tone: 'green' as Tone })),
    { offset: `rbp-${O0_FRAME}`, value: '到这里是 rsp', dim: true },
  ],
  pointers: [{ name: 'rbp', at: 1, tone: 'blue' }, { name: 'rsp', at: slotOffsets.length + 2, tone: 'amber' }],
});

export const frame: Lesson = seal({
  id: 'frame',
  name: 'STACK FRAME',
  title: '栈帧与调用约定',
  group: 'back',
  layer: [6, 6],
  nodes: ['regalloc', 'frame'],
  place: { regalloc: [240, 56], frame: [660, 56] },
  labels: { regalloc: ['函数代码', 'sum 和 scale'], frame: ['调用栈', '向低地址增长'] },
  panels: { frame: [10, 146, 420, 520], asm: [440, 146, 450, 350], regs: [440, 506, 450, 160] },
  initial,
  start: ['regalloc'],
  legend: [['amber', '入栈'], ['green', '出栈'], ['violet', 'scale 的帧'], [null, '地址是示例值，差值是真实的']],
  overview: {
    full: '函数怎么交接，局部的东西放哪',
    description: '调用一个函数要约定好：参数放哪，返回值放哪，谁负责保存寄存器，栈要怎么对齐。这些写在 System V AMD64 ABI 里，不同编译器产生的代码因此能互相调用。这一课真的执行 sum 的序言和尾声，看栈一格一格变化。',
    facts: [
      ['标准', 'System V AMD64 ABI'],
      ['栈增长方向', '向低地址'],
      ['对齐', `call 之前 rsp 是 16 的倍数`],
      ['sum 的局部空间', `${frameInfo.localBytes} 字节（都是填充）`],
      ['保存的寄存器', `rbp ${frameInfo.callee.map((reg) => REG64[reg]).join(' ')}`],
    ],
  },
  steps: [
    {
      title: '进入函数',
      desc: 'call 压入返回地址，rsp 变成 8 的奇数倍',
      detail: `ABI 要求 call 之前 rsp 是 16 的倍数。call 又压了 8 字节返回地址，所以刚进函数时 rsp 除以 16 余 8。参数已经在 edi 里了，这里用 n = ${N} 走一遍。栈从高地址向低地址长，下面的图上方地址高。`,
      facts: [['rsp mod 16', String(ENTRY_RSP % 16)], ['n', `edi = ${N}`], ['返回地址', '在 [rsp]']],
      events: [show('frame'), enterEvent],
    },
    {
      title: '序言',
      desc: '建立自己的帧，保存要用的寄存器',
      detail: 'push rbp 存好调用者的帧基址，mov rbp, rsp 定下自己的。上一课 %n 分到了 ebx，它是被调用者保存寄存器，谁用谁负责还原，所以要 push rbx。调用者保存的 ecx、esi 不用管，sum 想改就改。',
      facts: [['push rbp', '存调用者的帧基址'], ['push rbx', 'sum 要用 ebx'], ['ecx esi r8d', '调用者保存，不用存']],
      events: [pushRbp, movRbp, pushRbx],
    },
    {
      title: '对齐',
      desc: '差 8 字节，就补 8 字节',
      detail: `现在 rsp 比入口低 16 字节，除以 16 还余 8。接下来要 call scale，所以 sub rsp, ${frameInfo.localBytes} 补齐。对齐不是建议：被调函数可以假定入口时 rsp+8 是 16 的倍数，并用 movaps 这类要求对齐的指令访问栈，不对齐就会崩溃。这段填充没有存任何数据。`,
      facts: [['填充', `${frameInfo.padding} 字节`], ['对齐后 rsp mod 16', String(alignedRsp % 16)], ['依据', 'ABI 3.2.2 节']],
      events: [subRsp, movEbx],
    },
    {
      title: '调用 scale',
      desc: 'ebx 里的 n 能活过这次调用',
      detail: `循环结束后 s = ${S_VALUE}，%s.0 分到的正是 edi，实参不用再挪。call 压入返回地址，scale 建立自己的帧，算完把结果放进 eax 再返回。n 放在 ebx，scale 如果要用 ebx 必须自己保存还原，所以 sum 能放心地接着用。这就是分两类寄存器的意义。`,
      facts: [['实参', `edi = ${S_VALUE}`], ['返回值', `eax = ${S_VALUE * 2}`], ['结果', `${S_VALUE * 2} + ${N} = ${run.value}`]],
      events: [callEvent, scaleEvent, returnEvent, addEax],
    },
    {
      title: '尾声',
      desc: '按相反的顺序全部还回去',
      detail: '序言做了什么，尾声就反着做：add rsp 收回填充，pop rbx 和 pop rbp 恢复调用者的值。ret 弹出返回地址跳回去。此时 rsp 比进入时高 8，正好回到调用者 call 之前的位置，rbx 和 rbp 都和调用前一样，返回值在 eax。',
      facts: [['eax', String(run.value)], ['rbx', '已恢复'], ['rsp', '回到 call 之前']],
      events: [addRsp, popRbx, popRbp, retEvent],
    },
    {
      title: '对照 -O0',
      desc: '不做分配时，变量都在栈上',
      detail: `如果不优化，每个 alloca 都是一个栈槽：${slotOffsets.map((slot) => `${slot.name} 在 rbp${slot.offset}`).join('，')}。${slotOrder.length} 个 4 字节的变量共 ${slotOrder.length * 4} 字节，向上取到 16 的倍数，所以是 sub rsp, ${O0_FRAME}。clang -O0 的汇编确实如此，单元测试核对过。这个函数的 -O0 版本没有 push rbx，因为所有值都在内存里。`,
      facts: [['帧大小', `${O0_FRAME} 字节`], ['n 的位置', `rbp${slotOffsets[0].offset}`], ['编码', o0Line.enc.bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ')]],
      events: [
        pk('regalloc', 'frame', 'teal', '-O0 的写法', [o0Line.text.slice(0, 26)], [6, 'FRAME', `对照 clang -O0：${o0Line.text}，把参数存到栈槽`, o0Line.enc.bytes.length],
          wire('-O0 里第一个 store 的编码，带 8 位位移', 'mem', 'spec', instruction(o0Line, 'teal'), concept('-O0 的栈帧', slotOffsets.map((slot) => [slot.name, `rbp${slot.offset}`]), 'teal')), { art: { frame: o0View(), regs: regTable(new Machine()) } }),
        note('frame', '变量全在内存，慢但好调试', 'amber'),
      ],
    },
  ],
  outro: {
    title: '约定让代码能互相调用',
    desc: '编译器之间靠 ABI 配合',
    text: '只要遵守同一份 ABI，clang 编译的函数可以调用 GCC 或 Rust 编译的函数。真实的优化编译器通常省掉帧指针，把 rbp 也当普通寄存器用，这里保留它是为了让帧的结构看得清楚；clang -O2 编译这个函数时就没有 push rbp。',
    facts: [['参数', 'rdi rsi rdx rcx r8 r9'], ['返回值', 'rax'], ['下一课', 'ENCODING']],
  },
});
