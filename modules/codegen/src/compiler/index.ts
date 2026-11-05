/** 把示例程序跑完整条流水线。所有课程的产物都来自这里，模块加载时算一次。 */
import { check } from './sema';
import { generate } from './irgen';
import { fmtBody, slotNames, type IrFunc, type IrModule } from './ir';
import { lex } from './lexer';
import { parse, type Program } from './parser';
import { BAD_SOURCE, SCALE_SOURCE, SOURCE } from './source';
import { dominance, liveness, variableFlow } from './dataflow';
import { promote } from './ssa';
import { dce, licm, sccp } from './opt';
import { select } from './isel';
import { asmText, backend, type Assembled, type BackendResult, type LoweredFunc } from './emit';
import { writeObject } from './elf';
import { link } from './link';
import { buildSlr, EXPR_GRAMMAR, runLr } from './lr';
import { FULL_POOL, linearScan } from './regalloc';
import { RBX, RCX, RDX, RSI } from './x86';

export interface FunctionPipeline {
  o0: IrFunc;
  ssa: ReturnType<typeof promote>;
  sccp: ReturnType<typeof sccp>;
  dce: ReturnType<typeof dce>;
  licm: ReturnType<typeof licm>;
  mir: ReturnType<typeof select>;
  back: BackendResult;
}

export interface CompileResult {
  program: Program;
  sema: ReturnType<typeof check>;
  module: IrModule;
  genEvents: ReturnType<typeof generate>['events'];
  funcs: FunctionPipeline[];
  lowered: LoweredFunc[];
  assembled: Assembled[];
  asm: string;
  object: ReturnType<typeof writeObject>;
}

export function runFunction(fn: IrFunc): FunctionPipeline {
  const ssa = promote(fn);
  const constants = sccp(ssa.fn);
  const dead = dce(constants.fn);
  const hoisted = licm(dead.fn);
  const mir = select(hoisted.fn);
  const back = backend(mir);
  return { o0: fn, ssa, sccp: constants, dce: dead, licm: hoisted, mir, back };
}

/** 把一段源码编译到目标文件。出错时抛出，课程只用能通过的输入。 */
export function compile(source: string): CompileResult {
  const { program } = parse(source);
  const sema = check(program);
  if (sema.diagnostics.length) throw new Error(sema.diagnostics.map((item) => item.message).join('\n'));
  const { module, events } = generate(program);
  const funcs = module.funcs.map(runFunction);
  const lowered = funcs.map((item) => item.back.lowered);
  const assembled = funcs.map((item) => item.back.assembled);
  const asm = asmText(lowered, module.globals);
  const object = writeObject({ text: assembled, globals: module.globals });
  return { program, sema, module, genEvents: events, funcs, lowered, assembled, asm, object };
}

export const LEXED = lex(SOURCE);
export const PARSED = parse(SOURCE);
export const MAIN = compile(SOURCE);
export const SCALE_OBJ = compile(SCALE_SOURCE);
export const SUM = MAIN.funcs[0];
export const SEMA = MAIN.sema;
export const BAD_SEMA = check(parse(BAD_SOURCE).program);
export const LIVE = liveness(variableFlow(SUM.o0));
export const DOM = dominance(SUM.ssa.fn);
export const LINKED = link([MAIN.object, SCALE_OBJ.object]);

export const LR_TABLE = buildSlr(EXPR_GRAMMAR);
/** s + m * n + i：示例程序循环体里的那个表达式，直接取自词法器的结果。 */
export const LR_INPUT = (() => {
  const { tokens } = LEXED;
  const start = tokens.findIndex((token, index) => token.text === 's' && tokens[index + 1]?.text === '=' && tokens[index + 2]?.text === 's');
  const end = tokens.findIndex((token, index) => index > start && token.kind === 'semi');
  return tokens.slice(start + 2, end).map((token) => ({
    symbol: token.kind === 'identifier' ? 'id' : token.kind === 'numeric_constant' ? 'num' : token.text,
    text: token.text,
    token,
  }));
})();
export const LR_RUN = runLr(EXPR_GRAMMAR, LR_TABLE, LR_INPUT);

/** 演示溢出：同一批区间，只给 3 个调用者保存寄存器和 1 个被调用者保存寄存器。 */
export const TIGHT_POOL = [RCX, RDX, RSI, RBX];
export const TIGHT_ALLOC = linearScan(SUM.back.analysis, TIGHT_POOL);
export const FULL_ALLOC_POOL = FULL_POOL;

export { fmtBody, slotNames };
