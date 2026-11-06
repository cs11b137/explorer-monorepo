/**
 * 图像变 token（多模态理解的第一步）：ViT 的 patch embedding。
 *
 * 一张 8×8 的 RGB 小图切成 2×2 = 4 个 4×4 的 patch；每个 patch 展平成 4×4×3 = 48 个数，
 * 归一化到 [−1, 1]，乘一个 d_model × 48 的矩阵、加偏置和位置嵌入，得到一个和文本 token 同为 d_model 维的向量。
 * 这 4 个向量直接插进文本嵌入序列，交给同一个 Transformer（forwardEmbeds）。
 *
 * 和真实模型的对应：ViT 用步长等于 patch 大小的卷积做这一步，数学上就是「展平 + 线性投影」；
 * Fuyu 正是把 patch 线性投影后直接送进解码器。LLaVA、Qwen-VL 等在中间还有一个完整的视觉编码器和一个投影层，
 * 本站为了能逐个数字展示，省掉了视觉编码器。投影权重来自固定种子，没有训练，所以向量本身没有语义。
 */
import { gaussian, mulberry32 } from './prng';
import { FP32, FlopMeter, matvec, type Mat, type Vec } from './tensor';
import { NO_TOKEN, type InputVector } from './transformer';

export interface Image {
  width: number;
  height: number;
  /** 通道数：1 是灰度，3 是 RGB。 */
  channels: 1 | 3;
  /** 每个通道 0–255，按行优先、每个像素的通道依次排列（HWC），和 PPM、未压缩位图的像素区一样。 */
  data: number[];
}

/** 本站的示例图：天空、太阳、云、草地和一朵红花。每个字母是一个像素，颜色见 PALETTE。 */
const PIXELS = [
  'SYYSSSSS',
  'YYYYSWWS',
  'YYYYWWWW',
  'SYYSSSSS',
  'SSSSSSSS',
  'GGGGGRGG',
  'GGGGGDGG',
  'GGGGGGGG',
];

export const PALETTE: Record<string, [number, number, number]> = {
  S: [135, 196, 235], // 天空
  Y: [255, 210, 63], //  太阳
  W: [250, 250, 250], // 云
  G: [76, 160, 80], //   草地
  R: [220, 50, 60], //   花
  D: [40, 110, 50], //   花茎
};

export const SAMPLE_IMAGE: Image = {
  width: 8,
  height: 8,
  channels: 3,
  data: PIXELS.flatMap((row) => [...row].flatMap((key) => PALETTE[key])),
};

export interface VisionConfig {
  /** patch 的边长（像素）。 */
  patch: number;
  channels: 1 | 3;
  /** 图像边长，必须是 patch 的整数倍。 */
  imageSize: number;
  /** 投影到的维数，必须等于语言模型的 dModel。 */
  dModel: number;
}

export interface VisionWeights {
  config: VisionConfig;
  /** 投影矩阵，dModel × (patch² × channels)。 */
  patch_embd: Mat;
  patch_bias: Vec;
  /** 每个 patch 位置一行的位置嵌入，numPatches × dModel。 */
  pos_embd: Mat;
}

export const numPatches = (config: VisionConfig): number => (config.imageSize / config.patch) ** 2;
/** 一个 patch 展平后的长度。 */
export const patchDim = (config: VisionConfig): number => config.patch * config.patch * config.channels;

export function makeVisionConfig(dModel: number): VisionConfig {
  return { patch: 4, channels: 3, imageSize: 8, dModel };
}

/** 固定种子的投影权重：矩阵 ~ N(0, 1/patchDim)，偏置为 0，位置嵌入 ~ N(0, 0.1²)。 */
export function initVisionWeights(config: VisionConfig, seed = 20240715): VisionWeights {
  const normal = gaussian(mulberry32(seed));
  const dim = patchDim(config);
  const mat = (rows: number, cols: number, scale: number): Mat => Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.fround(normal() * scale)));
  return {
    config,
    patch_embd: mat(config.dModel, dim, 1 / Math.sqrt(dim)),
    patch_bias: new Array<number>(config.dModel).fill(0),
    pos_embd: mat(numPatches(config), config.dModel, 0.1),
  };
}

/** 像素归一化：先除以 255 到 [0, 1]，再按均值 0.5、标准差 0.5 标准化到 [−1, 1]（SigLIP 等用这组参数）。 */
export const normalizePixel = (byte: number): number => Math.fround((byte / 255 - 0.5) / 0.5);

export interface Patch {
  /** 第几个 patch，按行优先。 */
  index: number;
  row: number;
  col: number;
  /** 这个 patch 的原始字节，按 patch 内行优先、通道依次排列，长度 patch² × channels。 */
  bytes: number[];
  /** 归一化后的 patchDim 个数，投影的输入。 */
  values: Vec;
}

/** 把图切成 patch，按行优先编号。 */
export function patchify(image: Image, patch: number): Patch[] {
  if (image.width % patch || image.height % patch) throw new Error(`图像 ${image.width}×${image.height} 不能被 ${patch} 整除`);
  const out: Patch[] = [];
  const perRow = image.width / patch;
  for (let row = 0; row < image.height / patch; row++) {
    for (let col = 0; col < perRow; col++) {
      const bytes: number[] = [];
      for (let y = 0; y < patch; y++) {
        for (let x = 0; x < patch; x++) {
          const at = ((row * patch + y) * image.width + col * patch + x) * image.channels;
          for (let c = 0; c < image.channels; c++) bytes.push(image.data[at + c]);
        }
      }
      out.push({ index: row * perRow + col, row, col, bytes, values: bytes.map(normalizePixel) });
    }
  }
  return out;
}

export interface PatchEmbedTrace {
  patches: Patch[];
  /** W · x，还没加偏置和位置。 */
  projected: Vec[];
  /** 最终的 patch 向量：W · x + b + pos，每个 dModel 维。 */
  vectors: Vec[];
  meter: FlopMeter;
}

/** 图像 → patch 向量。投影的 FLOPs 记在 'other' 类。 */
export function patchEmbed(weights: VisionWeights, image: Image, meter = new FlopMeter()): PatchEmbedTrace {
  const { config } = weights;
  if (image.width !== config.imageSize || image.height !== config.imageSize || image.channels !== config.channels) throw new Error('图像尺寸或通道数和视觉配置不符');
  const patches = patchify(image, config.patch);
  const projected = patches.map((patch) => matvec(weights.patch_embd, patch.values, FP32, meter, 'other'));
  const vectors = projected.map((vec, i) => vec.map((value, d) => Math.fround(value + weights.patch_bias[d] + weights.pos_embd[i][d])));
  return { patches, projected, vectors, meter };
}

/** 图像 patch 变成 forwardEmbeds 能吃的输入，token 记为 NO_TOKEN。 */
export const imageInputs = (trace: PatchEmbedTrace): InputVector[] => trace.vectors.map((embed) => ({ token: NO_TOKEN, embed }));

/** 把图像向量插进文本输入的第 at 个位置之前（LLaVA 把提示词里的 <image> 占位符换成这些向量）。 */
export function spliceImage(text: readonly InputVector[], at: number, image: readonly InputVector[]): InputVector[] {
  return [...text.slice(0, at), ...image, ...text.slice(at)];
}

/** PPM（Netpbm P6）文件的字节：ASCII 头「P6\n宽 高\n255\n」加上原始 RGB 像素。最简单的真实图像格式。 */
export function ppmBytes(image: Image): number[] {
  if (image.channels !== 3) throw new Error('P6 只能存 RGB');
  const header = `P6\n${image.width} ${image.height}\n255\n`;
  return [...[...header].map((char) => char.charCodeAt(0)), ...image.data];
}

/** 和语言模型 dModel 一致的默认视觉权重（固定种子）。 */
export const visionFor = (dModel: number): VisionWeights => initVisionWeights(makeVisionConfig(dModel));
