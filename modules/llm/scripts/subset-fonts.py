"""
按本站实际用到的字符裁剪 Iosevka，写出 src/assets/fonts/iosevka-*.woff2。

字体源：Iosevka 22.1.2 的网页字体包（和其他模块用的版本相同）
    https://github.com/be5invis/Iosevka/releases/download/v22.1.2/webfont-iosevka-22.1.2.zip
    sha256 f039bc0bdcad32a3466664b3b12f0431bb1c1af3ebcc68943c0a3ccbdb877d7a
解压出 woff2/ 目录里的 iosevka-{regular,medium,semibold,bold,extrabold,extrabolditalic}.woff2。

运行（需要 fonttools 和 brotli：pip install fonttools brotli）：
    python scripts/subset-fonts.py <解压出的 woff2 目录>

字符集 = 可打印 ASCII
       + 本模块源码、index.html、引擎界面源码和共享包 llm-core 里出现的所有非中日韩字符
       + 运行时才生成的字符：GPT-2 字节映射用到的 U+00A1–U+0143（tokenizer.json 的写法），
         以及后续课程可能用到的数学符号（EXTRA）。
中文走系统字体，不进子集。课程里加了新符号，重新运行一次。
"""
import re
import sys
from pathlib import Path

from fontTools import subset

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT.parents[1] / 'packages' / 'engine' / 'src'
CORE = ROOT.parents[1] / 'packages' / 'llm-core' / 'src'
OUT = ROOT / 'src' / 'assets' / 'fonts'

WEIGHTS = {
    'iosevka-400-normal': 'iosevka-regular',
    'iosevka-500-normal': 'iosevka-medium',
    'iosevka-600-normal': 'iosevka-semibold',
    'iosevka-700-normal': 'iosevka-bold',
    'iosevka-800-normal': 'iosevka-extrabold',
    'iosevka-800-italic': 'iosevka-extrabolditalic',
}

# 运行时生成、源码里不一定直接出现的符号。
EXTRA = '×÷±−·…–—‘’“”←↑→↓↔⇒∅∞≈≠≤≥√∑∏∇∂∈⊙⊗⌊⌋⌈⌉αβγδεηθλμπσΣτφΔΩ²³⁰¹⁴⁵⁶⁷⁸⁹ⁿ⁻₀₁₂₃₄₅₆₇₈₉ᵀ␣✓✕°‰�'


def is_cjk(char: str) -> bool:
    cp = ord(char)
    return cp >= 0x2E80 and not (0xFE00 <= cp <= 0xFE0F) and cp not in (0xFFFD,)


def collect() -> set[str]:
    chars = {chr(cp) for cp in range(0x20, 0x7F)}
    chars |= {chr(cp) for cp in range(0xA1, 0x144)}
    chars |= set(EXTRA)
    files = [*ROOT.joinpath('src').rglob('*.ts'), ROOT / 'index.html', *ENGINE.rglob('*.ts'), *CORE.rglob('*.ts')]
    for path in files:
        if path.name == 'weights.data.ts':
            continue
        for char in path.read_text(encoding='utf-8'):
            if char.isprintable() and not is_cjk(char):
                chars.add(char)
    return chars


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    source = Path(sys.argv[1])
    chars = collect()
    unicodes = sorted(ord(char) for char in chars)
    for out_name, source_name in WEIGHTS.items():
        options = subset.Options()
        options.flavor = 'woff2'
        # 用 pyftsubset 的默认特性列表（和其他模块的字体一致）。Iosevka 有大量风格变体，全部保留会让文件大 5 倍。
        font = subset.load_font(str(source / f'{source_name}.woff2'), options)
        subsetter = subset.Subsetter(options)
        subsetter.populate(unicodes=unicodes)
        subsetter.subset(font)
        target = OUT / f'{out_name}.woff2'
        subset.save_font(font, str(target), options)
        print(f'{target.relative_to(ROOT)}  {target.stat().st_size} 字节，{len(font.getBestCmap())} 个字符')
    print(f'请求 {len(unicodes)} 个字符：', re.sub(r'\s', '', ''.join(sorted(chars)))[:200], '…')


main()
