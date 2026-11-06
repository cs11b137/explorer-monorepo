"""
独立参考：不共享 TypeScript 代码，生成 tests/vectors/*.json，测试里的期望值抄自它的输出。

- quant.json：fp16 用 numpy 的 float16，bf16、Q8_0、Q4_0 用 ggml 官方的 gguf-py（gguf.quants，numpy 实现，
  和 ggml-quants.c 的参考实现逐位一致）。
- forward.json：用 numpy 按 LLaMA 的公式重写一遍前向（RMSNorm、相邻两维的 RoPE、因果注意力、SwiGLU），
  读 src/model/weights.data.ts 里的同一份权重，算几段 token 序列的 logits。
- utf8.json：Python 自己的 UTF-8 编解码（含 errors='replace' 的替换规则）。

运行（需要 numpy 和 gguf：pip install numpy gguf）：
    python tests/reference/vectors.py
"""
import json
import math
import re
import sys
from importlib import metadata
from pathlib import Path

import numpy as np
from gguf import GGMLQuantizationType, quants

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'tests' / 'vectors'
OUT.mkdir(exist_ok=True)


def f32(values):
    return np.array(values, dtype=np.float32)


# ---------- 数值格式 ----------

# 64 个普通值（两块）+ 一块全 0 + 一块带 .5 平局和负的最大值。
base = [math.sin(i * 1.7) * 2.5 + ((i % 7) - 3) * 0.1 for i in range(64)]
zeros = [0.0] * 32
ties = [((i % 9) - 4) * 0.5 for i in range(31)] + [-3.0]
inputs = f32(base + zeros + ties)

def to_f16(values):
    # 65520 和 1e9 超出 fp16 范围，变成 inf 是预期行为，不需要警告。
    with np.errstate(over='ignore'):
        return values.astype(np.float16)


# 不放 -0.0：vite 导入 JSON 时会把它变成 0。-0 在 TypeScript 测试里单独核对。
specials = f32([0.0, 1.0, -2.0, 0.1, 1 / 3, 65504.0, 65519.0, 65520.0, 1e9, 2.0 ** -14, 2.0 ** -24, 2.0 ** -25, 3 * 2.0 ** -25, 6.0e-8, 1e-10, 3.14159265, -1.5e-5])

quant = {
    'tools': {'python': sys.version.split()[0], 'numpy': np.__version__, 'gguf': metadata.version('gguf')},
    'inputs': [float(x) for x in inputs],
    'specials': [float(x) for x in specials],
    'f16_specials': [int(x) for x in to_f16(specials).view(np.uint16)],
    'bf16_specials': [int(x) for x in quants.quantize(specials, GGMLQuantizationType.BF16).view(np.uint16)],
    'f16': to_f16(inputs).tobytes().hex(),
    'bf16': quants.quantize(inputs, GGMLQuantizationType.BF16).tobytes().hex(),
    'q8_0': quants.quantize(inputs, GGMLQuantizationType.Q8_0).tobytes().hex(),
    'q4_0': quants.quantize(inputs, GGMLQuantizationType.Q4_0).tobytes().hex(),
    'q8_0_dequant': [float(x) for x in quants.dequantize(quants.quantize(inputs, GGMLQuantizationType.Q8_0), GGMLQuantizationType.Q8_0)],
    'q4_0_dequant': [float(x) for x in quants.dequantize(quants.quantize(inputs, GGMLQuantizationType.Q4_0), GGMLQuantizationType.Q4_0)],
}
(OUT / 'quant.json').write_text(json.dumps(quant, indent=1) + '\n')


# ---------- 前向 ----------

source = (ROOT / 'src' / 'model' / 'weights.data.ts').read_text()
data = json.loads(re.search(r'= (\{.*\});\s*$', source, re.S).group(1))
import base64

raw = base64.b64decode(data['data'])


def tensor(name):
    entry = data['header'][name]
    a, b = entry['data_offsets']
    return np.frombuffer(raw[a:b], dtype='<f4').reshape(entry['shape']).astype(np.float64)


D, H, HD, L, EPS, BASE = 8, 2, 4, 2, 1e-5, 10000.0
W = {name: tensor(name) for name in data['header']}


def rmsnorm(x, g):
    return x / np.sqrt(np.mean(x * x, axis=-1, keepdims=True) + EPS) * g


def rope(x):
    out = x.copy()
    for pos in range(x.shape[0]):
        for h in range(H):
            for i in range(HD // 2):
                theta = pos * BASE ** (-2 * i / HD)
                a = h * HD + 2 * i
                c, s = math.cos(theta), math.sin(theta)
                out[pos, a] = x[pos, a] * c - x[pos, a + 1] * s
                out[pos, a + 1] = x[pos, a] * s + x[pos, a + 1] * c
    return out


def forward(tokens):
    x = W['token_embd.weight'][tokens]
    T = len(tokens)
    mask = np.triu(np.full((T, T), -np.inf), 1)
    for l in range(L):
        p = f'blk.{l}.'
        n = rmsnorm(x, W[p + 'attn_norm.weight'])
        q = rope(n @ W[p + 'attn_q.weight'].T)
        k = rope(n @ W[p + 'attn_k.weight'].T)
        v = n @ W[p + 'attn_v.weight'].T
        heads = []
        for h in range(H):
            sl = slice(h * HD, (h + 1) * HD)
            scores = q[:, sl] @ k[:, sl].T / math.sqrt(HD) + mask
            probs = np.exp(scores - scores.max(axis=1, keepdims=True))
            probs /= probs.sum(axis=1, keepdims=True)
            heads.append(probs @ v[:, sl])
        x = x + np.concatenate(heads, axis=1) @ W[p + 'attn_output.weight'].T
        n = rmsnorm(x, W[p + 'ffn_norm.weight'])
        gate = n @ W[p + 'ffn_gate.weight'].T
        up = n @ W[p + 'ffn_up.weight'].T
        x = x + (gate / (1 + np.exp(-gate)) * up) @ W[p + 'ffn_down.weight'].T
    return rmsnorm(x, W['output_norm.weight']) @ W['output.weight'].T


sequences = [[0x61], [283, 325, 187, 261], [257, 262, 101, 267, 12, 300, 77, 5, 88, 260]]
cases = []
for seq in sequences:
    # macOS 的 Accelerate 在 matmul 里会报假的浮点警告，这里关掉警告，改为直接检查结果是有限数。
    with np.errstate(all='ignore'):
        logits = forward(seq)
    assert np.isfinite(logits).all()
    cases.append({'tokens': seq, 'logits': [[float(f'{v:.7g}') for v in row] for row in logits]})
(OUT / 'forward.json').write_text(json.dumps({'tokenizer': data['tokenizer'], 'cases': cases}) + '\n')


# ---------- UTF-8 ----------

texts = ['大模型读 token', 'héllo, 世界 🙂', 'a\u0000b']
broken = [[0xE4, 0xB8], [0xE4, 0xB8, 0x41], [0xC0, 0xAF], [0xED, 0xA0, 0x80], [0xF0, 0x9F, 0x99], [0x80, 0x41], [0xF4, 0x90, 0x80, 0x80], [0xE6, 0xA8, 0xA1, 0xE5]]
(OUT / 'utf8.json').write_text(json.dumps({
    'encode': [{'text': t, 'bytes': list(t.encode('utf-8'))} for t in texts],
    'decode': [{'bytes': b, 'text': bytes(b).decode('utf-8', errors='replace')} for b in broken],
}, ensure_ascii=False, indent=1) + '\n')

print('写出', ', '.join(sorted(p.name for p in OUT.glob('*.json'))))
