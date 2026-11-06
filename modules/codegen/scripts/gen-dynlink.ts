/**
 * 动态链接课的独立向量：用 clang 汇编本站的汇编文本，再用 lld 链接成 libscale.so 和依赖它的 a.out，
 * 保存各节的地址和字节，以及 llvm-objdump 的读数。npm run vectors 会顺带运行；也可以单独运行：
 *   LLD=/path/to/ld.lld npx vite-node scripts/gen-dynlink.ts
 * lld 可以是 ld.lld，也可以是多合一的 lld（会自动加 -flavor gnu）。本机用的是 Android SDK 自带的 LLD 9.0.7。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { MAIN, SCALE_OBJ } from '../src/compiler';
import { LD_SO } from '../src/compiler/dynlink';
import { parseObject } from '../src/compiler/elf';

const OUT = resolve('tests/vectors');
const TMP = mkdtempSync(join(tmpdir(), 'codegen-dynlink-'));
const LLD = process.env.LLD ?? 'ld.lld';
const lldArgs = basename(LLD) === 'lld' ? ['-flavor', 'gnu'] : [];

const run = (tool: string, args: string[]) => execFileSync(tool, args, { cwd: TMP, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
const objdump = run('xcrun', ['-f', 'llvm-objdump']).trim();

writeFileSync(join(TMP, 'sum.s'), MAIN.asm);
writeFileSync(join(TMP, 'scale.s'), SCALE_OBJ.asm);
run('clang', ['-target', 'x86_64-unknown-linux-gnu', '-c', 'sum.s', '-o', 'sum.o']);
run('clang', ['-target', 'x86_64-unknown-linux-gnu', '-c', 'scale.s', '-o', 'scale.o']);
run(LLD, [...lldArgs, '-shared', '-soname', 'libscale.so', 'scale.o', '-o', 'libscale.so']);
// 没有 crt 和 libc，入口直接设成 sum：只为看链接器怎么处理对共享库函数的调用。
run(LLD, [...lldArgs, '-dynamic-linker', LD_SO, '-e', 'sum', 'sum.o', 'libscale.so', '-o', 'a.out']);

/** 只保存有地址、有内容的节，以及 e_phnum：其余是 lld 自己的元数据，和动态链接无关。lld 9 会留一个空的 .bss.rel.ro，也去掉。 */
function sections(path: string) {
  const bytes = readFileSync(join(TMP, path));
  const object = parseObject(bytes);
  return {
    phnum: bytes.readUInt16LE(56),
    sections: object.sections.filter((section) => section.addr && section.size).map((section) => ({
      name: section.name,
      type: section.type,
      addr: section.addr,
      size: section.size,
      link: section.link ? object.sections[section.link].name : '',
      hex: section.type === 8 ? '' : bytes.subarray(section.offset, section.offset + section.size).toString('hex'),
    })),
  };
}

const version = run(LLD, [...lldArgs, '--version']).trim();
writeFileSync(join(OUT, 'lld-dynlink.json'), `${JSON.stringify({ lld: version, exe: sections('a.out'), lib: sections('libscale.so') }, null, 1)}\n`);
writeFileSync(join(OUT, 'objdump-dynlink.txt'), run(objdump, ['-d', '-R', '-T', '-p', '--section-headers', 'a.out']) + run(objdump, ['-d', '-T', 'libscale.so']));
console.log('动态链接向量已写入', OUT, version);
