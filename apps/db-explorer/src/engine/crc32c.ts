/** CRC-32C（Castagnoli）。多项式取反射形式 0x82F63B78，与 src/include/port/pg_crc32c.h 的定义一致。 */
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** INIT_CRC32C */
export const CRC_INIT = 0xffffffff;

/** COMP_CRC32C：继续把字节算进去，不做最后的取反。 */
export function crcUpdate(crc: number, data: ArrayLike<number>, from = 0, to = data.length): number {
  let c = crc;
  for (let i = from; i < to; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

/** FIN_CRC32C */
export const crcFinal = (crc: number): number => (crc ^ 0xffffffff) >>> 0;

export const crc32c = (data: ArrayLike<number>): number => crcFinal(crcUpdate(CRC_INIT, data));
