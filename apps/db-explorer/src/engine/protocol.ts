import { asciiBytes } from './bytes';

/** 前后端协议 3.0 的消息编码：https://www.postgresql.org/docs/17/protocol-message-formats.html */
const int32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const int16 = (v: number): number[] => [(v >>> 8) & 0xff, v & 0xff];
const cstr = (text: string): number[] => [...new TextEncoder().encode(text), 0];
const message = (type: string, body: number[]): Uint8Array => new Uint8Array([type.charCodeAt(0), ...int32(body.length + 4), ...body]);

export const queryMessage = (sql: string): Uint8Array => message('Q', cstr(sql));

export interface FieldDesc {
  name: string;
  tableOid: number;
  attnum: number;
  typeOid: number;
  typlen: number;
}

export const rowDescription = (fields: FieldDesc[]): Uint8Array =>
  message('T', [...int16(fields.length), ...fields.flatMap((f) => [...cstr(f.name), ...int32(f.tableOid), ...int16(f.attnum), ...int32(f.typeOid), ...int16(f.typlen), ...int32(0xffffffff), ...int16(0)])]);

export const dataRow = (values: string[]): Uint8Array => message('D', [...int16(values.length), ...values.flatMap((v) => [...int32(v.length), ...asciiBytes(v)])]);

export const commandComplete = (tag: string): Uint8Array => message('C', cstr(tag));

export const readyForQuery = (status = 'I'): Uint8Array => message('Z', [status.charCodeAt(0)]);

export const errorResponse = (fields: Array<[string, string]>): Uint8Array => message('E', [...fields.flatMap(([code, value]) => [code.charCodeAt(0), ...cstr(value)]), 0]);
