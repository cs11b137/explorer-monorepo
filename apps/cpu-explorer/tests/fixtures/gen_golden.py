#!/usr/bin/env python3
"""生成 RV32I 黄金向量。需要 ziglang（自带 clang/LLVM，能汇编 riscv32）和 unicorn（QEMU 派生的模拟器）。
   rv32i-llvm.json：汇编文本 → LLVM 汇编器产出的指令字。
   rv32i-unicorn.json：程序 → Unicorn 跑完后的寄存器和内存。
   运行：python gen_golden.py   （本机 Apple clang 不带 RISC-V 后端，所以用 zig cc）"""
import json, os, random, struct, subprocess, sys, tempfile
from unicorn import Uc, UC_ARCH_RISCV, UC_MODE_RISCV32
from unicorn.riscv_const import UC_RISCV_REG_X0

HERE = os.path.dirname(os.path.abspath(__file__))

def assemble(lines):
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, 'a.s'); obj = os.path.join(tmp, 'a.o')
        with open(src, 'w') as f: f.write('.option norelax\n.text\n' + '\n'.join(lines) + '\n')
        subprocess.run([sys.executable, '-m', 'ziglang', 'cc', '-target', 'riscv32-freestanding', '-mcpu=generic_rv32+m', '-c', src, '-o', obj], check=True)
        return text_section(open(obj, 'rb').read())

def text_section(elf):
    shoff = struct.unpack_from('<I', elf, 32)[0]; shentsize, shnum, shstrndx = struct.unpack_from('<HHH', elf, 46)
    def sh(i): return struct.unpack_from('<10I', elf, shoff + i * shentsize)
    names = sh(shstrndx)
    for i in range(shnum):
        s = sh(i)
        name = elf[names[4] + s[0]:].split(b'\0')[0]
        if name == b'.text':
            data = elf[s[4]:s[4] + s[5]]
            return [struct.unpack_from('<I', data, o)[0] for o in range(0, len(data), 4)]
    raise RuntimeError('no .text')

R = random.Random(20261105)
reg = lambda: f'x{R.randrange(32)}'
RTYPE = 'add sub sll slt sltu xor srl sra or and mul'.split()
ITYPE = 'addi slti sltiu xori ori andi'.split()
SHIFT = 'slli srli srai'.split()
LOAD = 'lb lh lw lbu lhu'.split()
STORE = 'sb sh sw'.split()
BRANCH = 'beq bne blt bge bltu bgeu'.split()

def edge_lines():
    out = ['add x3, x1, x2', 'sub x3, x1, x2', 'addi x1, x0, 5', 'addi x1, x0, -1', 'addi x31, x31, 2047', 'addi x1, x1, -2048', 'nop']
    out += [f'{n} x5, x6, x7' for n in RTYPE]
    out += [f'{n} x5, x6, -2048' for n in ITYPE] + [f'{n} x5, x6, 2047' for n in ITYPE]
    out += [f'{n} x5, x6, {s}' for n in SHIFT for s in (0, 1, 31)]
    out += [f'{n} x5, -2048(x6)' for n in LOAD] + [f'{n} x5, 2047(x6)' for n in LOAD]
    out += [f'{n} x5, -2048(x6)' for n in STORE] + [f'{n} x5, 2047(x6)' for n in STORE]
    for n in BRANCH:
        for off in (-4096, -4094, -2048, -2, 2, 8, 2046, 2048, 4094):
            out.append(f'{n} x5, x6, {off}')
    for off in (-1048576, -1048574, -4096, -2048, -4, -2, 2, 4, 2046, 2048, 4094, 4096, 524288, 1048574):
        out.append(f'jal x1, {off}')
    out += ['jalr x1, 0(x5)', 'jalr x0, -4(x1)', 'jalr x1, 2047(x31)']
    out += ['lui x5, 0x0', 'lui x5, 0x1', 'lui x5, 0x12345', 'lui x31, 0xfffff', 'auipc x5, 0x0', 'auipc x5, 0x12345', 'auipc x31, 0xfffff']
    out += ['ecall', 'ebreak']
    return out

def random_line():
    k = R.randrange(8)
    if k == 0: return f'{R.choice(RTYPE)} {reg()}, {reg()}, {reg()}'
    if k == 1: return f'{R.choice(ITYPE)} {reg()}, {reg()}, {R.randint(-2048, 2047)}'
    if k == 2: return f'{R.choice(SHIFT)} {reg()}, {reg()}, {R.randint(0, 31)}'
    if k == 3: return f'{R.choice(LOAD)} {reg()}, {R.randint(-2048, 2047)}({reg()})'
    if k == 4: return f'{R.choice(STORE)} {reg()}, {R.randint(-2048, 2047)}({reg()})'
    if k == 5: return f'{R.choice(BRANCH)} {reg()}, {reg()}, {R.randrange(-2048, 2047) * 2}'
    if k == 6: return f'jal {reg()}, {R.randrange(-524288, 524287) * 2}'
    return f'{R.choice(["lui", "auipc"])} {reg()}, {hex(R.randrange(0, 1 << 20))}'

# ---- 课程里用到的程序，以及随机程序 ----
LESSON_PROGRAMS = {
    'hazard': ['addi x2, x0, 7', 'addi x5, x0, 3', 'add x1, x2, x5', 'sub x4, x1, x5', 'sw x4, 256(x0)', 'lw x6, 256(x0)', 'and x7, x6, x1', 'or x8, x7, x6'],
    'loop': ['addi x1, x0, 0', 'addi x2, x0, 10', 'loop:', 'addi x1, x1, 1', 'bne x1, x2, loop', 'addi x3, x1, 100', 'addi x4, x1, 200'],
    'nested': ['addi x1, x0, 0', 'addi x5, x0, 3', 'outer:', 'addi x2, x0, 0', 'addi x6, x0, 4', 'inner:', 'addi x2, x2, 1', 'bne x2, x6, inner', 'addi x1, x1, 1', 'bne x1, x5, outer'],
    'datapath': ['addi x1, x0, 5', 'add x2, x1, x1', 'sw x2, 256(x0)', 'lw x3, 256(x0)', 'beq x2, x3, 8', 'addi x4, x0, 99', 'lui x5, 0x12345'],
    'control': ['addi x1, x0, 12', 'add x2, x1, x1', 'sw x2, 256(x0)', 'lw x3, 256(x0)', 'beq x2, x3, 8', 'addi x4, x0, 1', 'jal x5, 8', 'addi x6, x0, 1', 'addi x7, x0, 2'],
    'pipeline': ['addi x1, x0, 1', 'addi x2, x0, 2', 'addi x3, x0, 3', 'addi x4, x0, 4', 'addi x5, x0, 5'],
}

BASE_RAM = 0x2000

def random_program(seed):
    r = random.Random(seed)
    lines = ['lui x31, 0x2']  # x31 = 0x2000 指向数据区
    for i in range(1, 8):
        lines.append(f'addi x{i}, x0, {r.randint(-2048, 2047)}')
    live = [f'x{i}' for i in range(1, 16)]
    rr = lambda: r.choice(live)
    n = r.randint(25, 60)
    labels = 0
    while len(lines) < n:
        k = r.randrange(10)
        if k <= 2: lines.append(f'{r.choice(RTYPE[:10])} {rr()}, {rr()}, {rr()}')
        elif k == 3: lines.append(f'{r.choice(ITYPE)} {rr()}, {rr()}, {r.randint(-2048, 2047)}')
        elif k == 4: lines.append(f'{r.choice(SHIFT)} {rr()}, {rr()}, {r.randint(0, 31)}')
        elif k == 5: lines.append(f'{r.choice(LOAD)} {rr()}, {r.randrange(0, 256)}(x31)')
        elif k == 6: lines.append(f'{r.choice(STORE)} {rr()}, {r.randrange(0, 256)}(x31)')
        elif k == 7:
            labels += 1
            lines.append(f'{r.choice(BRANCH)} {rr()}, {rr()}, L{labels}')
            lines.append(f'addi {rr()}, {rr()}, {r.randint(-16, 16)}')
            lines.append(f'L{labels}:')
        elif k == 8:
            labels += 1
            lines.append(f'jal x{r.randint(16, 20)}, L{labels}')
            lines.append(f'addi {rr()}, {rr()}, 1')
            lines.append(f'L{labels}:')
        else:
            labels += 1
            c = r.randint(2, 5)
            lines.append(f'addi x20, x0, {c}')
            lines.append(f'L{labels}:')
            lines.append(f'add {rr()}, {rr()}, {rr()}')
            lines.append('addi x20, x20, -1')
            lines.append(f'bne x20, x0, L{labels}')
    return lines

def emulate(words):
    uc = Uc(UC_ARCH_RISCV, UC_MODE_RISCV32)
    uc.mem_map(0, 0x10000)
    code = b''.join(struct.pack('<I', w) for w in words)
    uc.mem_write(0, code)
    uc.emu_start(0, len(code), count=200000)
    regs = [uc.reg_read(UC_RISCV_REG_X0 + i) & 0xffffffff for i in range(32)]
    data = {}
    for base in (0x100, BASE_RAM):
        raw = uc.mem_read(base, 512)
        for i, b in enumerate(raw):
            if b: data[base + i] = b
    return regs, data

def main():
    lines = edge_lines() + [random_line() for _ in range(400)]
    words = assemble(lines)
    assert len(words) == len(lines)
    json.dump({'source': 'zig cc 0.17 (clang/LLVM 22.1.8) -target riscv32-freestanding -mcpu=generic_rv32+m', 'vectors': [[l, f'0x{w:08x}'] for l, w in zip(lines, words)]}, open(os.path.join(HERE, 'rv32i-llvm.json'), 'w'), indent=0)
    programs = dict(LESSON_PROGRAMS)
    for seed in range(40): programs[f'random{seed}'] = random_program(1000 + seed)
    out = {}
    for name, source in programs.items():
        code = assemble(source)
        regs, data = emulate(code)
        out[name] = {'source': source, 'words': [f'0x{w:08x}' for w in code], 'regs': regs, 'memory': {str(k): v for k, v in data.items()}}
    json.dump({'source': f'unicorn {__import__("unicorn").__version__} RISCV32', 'programs': out}, open(os.path.join(HERE, 'rv32i-unicorn.json'), 'w'), indent=0)
    print(len(lines), 'vectors,', len(out), 'programs')

main()
