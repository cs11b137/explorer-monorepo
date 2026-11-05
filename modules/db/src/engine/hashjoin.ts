/** 依据 src/common/hashfn.c 和 src/backend/executor/nodeHash.c（REL_17_STABLE）。 */
const rot = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** hash_bytes_uint32，也就是 hashint4 对 int4 用的函数。 */
export function hashInt4(k: number): number {
  let a = (0x9e3779b9 + 4 + 3923095) >>> 0;
  let b = a;
  let c = a;
  a = (a + (k >>> 0)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rot(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rot(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rot(b, 24)) >>> 0;
  return c;
}

const log2 = (n: number): number => 31 - Math.clz32(n);
const rotateRight = (x: number, k: number) => (k === 0 ? x >>> 0 : ((x >>> k) | (x << (32 - k))) >>> 0);

/** ExecHashGetBucketAndBatch：低位选桶，旋转后的低位选批。两者用的位不重叠。 */
export function bucketAndBatch(hash: number, nbuckets: number, nbatch: number): { bucket: number; batch: number } {
  const bucket = (hash & (nbuckets - 1)) >>> 0;
  const batch = nbatch > 1 ? (rotateRight(hash, log2(nbuckets)) & (nbatch - 1)) >>> 0 : 0;
  return { bucket, batch };
}

const nextPower2 = (n: number): number => {
  let p = 1;
  while (p < n) p *= 2;
  return p;
};
const prevPower2 = (n: number): number => {
  let p = 1;
  while (p * 2 <= n) p *= 2;
  return p;
};

const HJTUPLE_OVERHEAD = 16;
const SIZEOF_MINIMAL_HEADER = 16; // MAXALIGN(SizeofMinimalTupleHeader = 15)
const MAXALIGN = (n: number) => (n + 7) & ~7;

/** ExecChooseHashTableSize（非并行、无倾斜优化）。 */
export function chooseHashTableSize(ntuples: number, tupwidth: number, hashMemBytes: number): { nbuckets: number; nbatch: number; tupsize: number } {
  const tupsize = HJTUPLE_OVERHEAD + SIZEOF_MINIMAL_HEADER + MAXALIGN(tupwidth);
  const innerBytes = ntuples * tupsize;
  const maxPointers = prevPower2(Math.floor(hashMemBytes / 8));
  let nbuckets = Math.max(Math.min(Math.ceil(ntuples), maxPointers), 1024);
  nbuckets = nextPower2(nbuckets);
  let nbatch = 1;
  if (innerBytes + 8 * nbuckets > hashMemBytes) {
    const bucketSize = tupsize + 8;
    let sbuckets = hashMemBytes <= bucketSize ? 1 : nextPower2(Math.floor(hashMemBytes / bucketSize));
    sbuckets = Math.min(sbuckets, maxPointers);
    nbuckets = nextPower2(sbuckets);
    const bucketBytes = nbuckets * 8;
    const dbatch = Math.min(Math.ceil(innerBytes / (hashMemBytes - bucketBytes)), maxPointers);
    nbatch = nextPower2(Math.max(2, dbatch));
  }
  return { nbuckets, nbatch, tupsize };
}

export interface HashRow {
  key: number;
  name: string;
}

export interface BuildStep {
  row: HashRow;
  hash: number;
  bucket: number;
  batch: number;
  action: 'insert' | 'spill';
}

export interface ProbeStep {
  row: HashRow;
  hash: number;
  bucket: number;
  batch: number;
  action: 'probe' | 'spill';
  matches: HashRow[];
  /** 这次探测沿链表比较了几个元组。 */
  compared: number;
}

/** 真实的哈希连接：头插法建链表，探测时先比哈希值再比键。 */
export class HashJoin {
  buckets: BuildStep[][];
  innerBatch: BuildStep[] = [];
  outerBatch: ProbeStep[] = [];

  constructor(readonly nbuckets: number, readonly nbatch: number) {
    this.buckets = Array.from({ length: nbuckets }, () => []);
  }

  /** ExecHashTableInsert：当前批放内存，别的批写到临时文件。 */
  insert(row: HashRow, curBatch = 0): BuildStep {
    const hash = hashInt4(row.key);
    const { bucket, batch } = bucketAndBatch(hash, this.nbuckets, this.nbatch);
    const step: BuildStep = { row, hash, bucket, batch, action: batch === curBatch ? 'insert' : 'spill' };
    if (step.action === 'insert') this.buckets[bucket].unshift(step);
    else this.innerBatch.push(step);
    return step;
  }

  /** ExecHashJoinImpl 的探测段：ExecHashGetBucketAndBatch + ExecScanHashBucket。 */
  probe(row: HashRow, curBatch = 0): ProbeStep {
    const hash = hashInt4(row.key);
    const { bucket, batch } = bucketAndBatch(hash, this.nbuckets, this.nbatch);
    if (batch !== curBatch) {
      const spill: ProbeStep = { row, hash, bucket, batch, action: 'spill', matches: [], compared: 0 };
      this.outerBatch.push(spill);
      return spill;
    }
    const chain = this.buckets[bucket];
    const matches = chain.filter((item) => item.hash === hash && item.row.key === row.key).map((item) => item.row);
    return { row, hash, bucket, batch, action: 'probe', matches, compared: chain.length };
  }

  /** ExecHashTableReset + 读回下一批的内表，重新建表。 */
  loadBatch(batch: number): BuildStep[] {
    this.buckets = Array.from({ length: this.nbuckets }, () => []);
    const loaded = this.innerBatch.filter((item) => item.batch === batch);
    this.innerBatch = this.innerBatch.filter((item) => item.batch !== batch);
    for (const item of loaded) this.buckets[item.bucket].unshift({ ...item, action: 'insert' });
    return loaded;
  }
}
