/**
 * 用本机工具生成独立的测试向量：clang 的词法、语法树、IR，clang 汇编出的字节，
 * bison 的 LALR 状态，以及在 Rosetta 下真实运行的结果。运行：npm run vectors
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compile, MAIN, LINKED, SCALE_OBJ } from '../src/compiler';
import { fmtModule, type IrFunc } from '../src/compiler/ir';
import { asmText } from '../src/compiler/emit';
import { BAD_SOURCE, SCALE_SOURCE, SOURCE } from '../src/compiler/source';
import { fmtIns } from '../src/compiler/x86';
import { ENCODER_MATRIX } from '../tests/vectors/matrix';

const OUT = resolve('tests/vectors');
const TMP = mkdtempSync(join(tmpdir(), 'codegen-vectors-'));
const TARGET = ['-target', 'x86_64-unknown-linux-gnu', '-ffreestanding'];

const run = (tool: string, args: string[], input?: string) => execFileSync(tool, args, { cwd: TMP, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const runAll = (tool: string, args: string[]) => {
  // clang 把 -dump-tokens 和诊断都写到 stderr。
  try {
    const stdout = execFileSync(tool, args, { cwd: TMP, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
    return stdout;
  } catch (error) {
    const failure = error as { stderr?: string; stdout?: string };
    return `${failure.stdout ?? ''}${failure.stderr ?? ''}`;
  }
};
const stderrOf = (tool: string, args: string[]) => {
  const result = execFileSync('/bin/sh', ['-c', `${tool} ${args.join(' ')} 2>&1`], { cwd: TMP, encoding: 'utf8', maxBuffer: 1 << 26 });
  return result;
};
const objdump = run('xcrun', ['-f', 'llvm-objdump']).trim();
const save = (name: string, text: string) => writeFileSync(join(OUT, name), text);
const hexOf = (path: string) => readFileSync(join(TMP, path)).toString('hex');

writeFileSync(join(TMP, 'sum.c'), SOURCE);
writeFileSync(join(TMP, 'scale.c'), SCALE_SOURCE);
writeFileSync(join(TMP, 'bad.c'), BAD_SOURCE);

save('tool-versions.txt', `${run('clang', ['--version'])}${run(objdump, ['--version']).split('\n').slice(0, 2).join('\n')}\n${run('bison', ['--version']).split('\n')[0]}\n`);
save('clang-tokens.txt', stderrOf('clang', [...TARGET, '-fsyntax-only', '-Xclang', '-dump-tokens', 'sum.c']));
save('clang-ast.txt', run('clang', [...TARGET, '-fsyntax-only', '-Xclang', '-ast-dump', 'sum.c']).replace(/0x[0-9a-f]+ /g, '').replace(/\x1b\[[0-9;]*m/g, ''));
save('clang-bad.txt', runAll('clang', [...TARGET, '-fsyntax-only', '-fno-color-diagnostics', 'bad.c']));
save('clang-o0.ll', run('clang', [...TARGET, '-S', '-emit-llvm', '-O0', '-fno-discard-value-names', 'sum.c', '-o', '-']));
save('clang-sroa.ll', stderrOf('clang', [...TARGET, '-O1', '-S', '-emit-llvm', '-fno-discard-value-names', '-mllvm', '-print-after=sroa', '-mllvm', '-filter-print-funcs=sum', 'sum.c', '-o', '/dev/null']));
save('clang-licm.ll', stderrOf('clang', [...TARGET, '-O1', '-S', '-emit-llvm', '-fno-discard-value-names', '-mllvm', '-print-after=licm', '-mllvm', '-filter-print-funcs=sum', 'sum.c', '-o', '/dev/null']));
save('clang-o1.ll', run('clang', [...TARGET, '-O1', '-S', '-emit-llvm', '-fno-discard-value-names', 'sum.c', '-o', '-']));
save('clang-o0.s', run('clang', [...TARGET, '-O0', '-S', '-masm=intel', 'sum.c', '-o', '-']));
save('clang-o2.s', run('clang', [...TARGET, '-O2', '-S', '-masm=intel', 'sum.c', '-o', '-']));

// 我们的汇编文本交给 clang 汇编，得到的字节就是编码器和 ELF 写入器的标准答案。
writeFileSync(join(TMP, 'ours.s'), MAIN.asm);
run('clang', ['-target', 'x86_64-unknown-linux-gnu', '-c', 'ours.s', '-o', 'ours.o']);
writeFileSync(join(TMP, 'scale.s'), SCALE_OBJ.asm);
run('clang', ['-target', 'x86_64-unknown-linux-gnu', '-c', 'scale.s', '-o', 'scale.o']);
save('clang-assembled.json', JSON.stringify({ asm: MAIN.asm, object: hexOf('ours.o'), scaleAsm: SCALE_OBJ.asm, scaleObject: hexOf('scale.o') }, null, 1));
save('objdump-sum.txt', run(objdump, ['-d', '-r', '--section-headers', '--syms', 'ours.o']));

// 编码矩阵。
const matrixAsm = ['\t.intel_syntax noprefix', '\t.text', ...ENCODER_MATRIX.map((ins) => `\t${fmtIns(ins)}`), ''].join('\n');
writeFileSync(join(TMP, 'matrix.s'), matrixAsm);
run('clang', ['-target', 'x86_64-unknown-linux-gnu', '-c', 'matrix.s', '-o', 'matrix.o']);
// 边界取自 -d 的地址列，字节取自 -s 的十六进制转储。
const contents = run(objdump, ['-s', '--section=.text', 'matrix.o']).split('\n').flatMap((line) => {
  const match = line.match(/^ [0-9a-f]+ ((?:[0-9a-f]{2,8} ){1,4})/);
  return match ? [match[1].replace(/ /g, '')] : [];
}).join('');
const starts = run(objdump, ['-d', 'matrix.o']).split('\n').flatMap((line) => {
  const match = line.match(/^\s*([0-9a-f]+):\s[0-9a-f]{2}[ \t]/);
  return match ? [parseInt(match[1], 16)] : [];
});
const lines = starts.map((start, index) => contents.slice(start * 2, (starts[index + 1] ?? contents.length / 2) * 2));
if (lines.length !== ENCODER_MATRIX.length) throw new Error(`矩阵条数不符：${lines.length} / ${ENCODER_MATRIX.length}`);
save('clang-encoder.json', JSON.stringify(ENCODER_MATRIX.map((ins, index) => ({ text: fmtIns(ins), hex: lines[index] })), null, 0));

// 链接结果：只有 llvm-objdump 能独立读，没有可用的 ELF 链接器。
writeFileSync(join(TMP, 'image'), Buffer.from(LINKED.image));
save('objdump-image.txt', run(objdump, ['-d', '--syms', '--section-headers', 'image']));

// bison 的 LALR 自动机。表达式文法是 SLR(1)，状态数只差 bison 自己的 $accept 结束状态。
writeFileSync(join(TMP, 'expr.y'), `%token ID NUM\n%%\nE: E '+' T | T ;\nT: T '*' F | F ;\nF: '(' E ')' | ID | NUM ;\n%%\n`);
run('bison', ['-v', 'expr.y', '-o', 'expr.tab.c']);
save('bison-expr.output', readFileSync(join(TMP, 'expr.output'), 'utf8'));

// 真实运行：x86-64 Mach-O + Rosetta。同一个调用约定，只换符号前缀。
const DRIVERS: Record<string, string> = {
  sum: `#include <stdio.h>\nint scale(int v) { return v * 2; }\nint sum(int);\nextern int total;\nint main(void) { int ns[] = {-3, 0, 1, 2, 5, 17, 100}; for (int i = 0; i < 7; i++) { int r = sum(ns[i]); printf("%d %d %d\\n", ns[i], r, total); } return 0; }\n`,
  pair: `#include <stdio.h>\nint helper(int a, int b, int c) { return a * 2 + b - c; }\nint f(int, int);\nint main(void) { int as[] = {-5, 0, 1, 3, 8, 20}; int bs[] = {-2, 0, 1, 4, 7}; for (int i = 0; i < 6; i++) for (int j = 0; j < 5; j++) printf("%d %d %d\\n", as[i], bs[j], f(as[i], bs[j])); return 0; }\n`,
};

function runStages(name: string, source: string, driver: string): Record<string, string> {
  writeFileSync(join(TMP, `${name}.c`), source);
  writeFileSync(join(TMP, `${name}-driver.c`), driver);
  const exec = (label: string, inputs: string[]) => {
    run('clang', ['-arch', 'x86_64', '-w', ...inputs, `${name}-driver.c`, '-o', `${name}-${label}`]);
    return run('arch', ['-x86_64', `./${name}-${label}`]);
  };
  const out: Record<string, string> = { reference: exec('ref', [`${name}.c`]) };
  const result = compile(source);
  writeFileSync(join(TMP, `${name}-macho.s`), asmText(result.lowered, result.module.globals, 'macho'));
  out.machine = exec('asm', [`${name}-macho.s`]);
  const stageFuncs: Record<string, IrFunc[]> = {
    o0: result.funcs.map((item) => item.o0),
    ssa: result.funcs.map((item) => item.ssa.fn),
    sccp: result.funcs.map((item) => item.sccp.fn),
    dce: result.funcs.map((item) => item.dce.fn),
    licm: result.funcs.map((item) => item.licm.fn),
  };
  for (const [stage, funcs] of Object.entries(stageFuncs)) {
    writeFileSync(join(TMP, `${name}-${stage}.ll`), fmtModule({ ...result.module, funcs }, 'x86_64-apple-macosx11.0.0'));
    out[stage] = exec(stage, ['-x', 'ir', `${name}-${stage}.ll`, '-x', 'none']);
  }
  return out;
}

const runs: Record<string, Record<string, string>> = { sum: runStages('sum', SOURCE, DRIVERS.sum) };
const programIr: Record<string, string> = {};
for (const file of readdirSync(join(OUT, 'programs')).filter((item) => item.endsWith('.c'))) {
  const name = file.replace(/\.c$/, '');
  const source = readFileSync(join(OUT, 'programs', file), 'utf8');
  runs[name] = runStages(name, source, DRIVERS.pair);
  writeFileSync(join(TMP, file), source);
  programIr[name] = run('clang', [...TARGET, '-S', '-emit-llvm', '-O0', '-fno-discard-value-names', file, '-o', '-']);
}
save('runs.json', JSON.stringify(runs, null, 1));
save('programs-o0.json', JSON.stringify(programIr, null, 1));
console.log('向量已写入', OUT);
