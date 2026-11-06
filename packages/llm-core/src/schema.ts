/**
 * 原在 AGENT EXPLORER 的 src/core/schema.ts（那里转导出，接口不变；LLMOPS EXPLORER 的确定性评估也用）。
 *
 * 一个很小的 JSON Schema 校验器：只实现工具参数用得到的关键字（type、properties、required、additionalProperties: false、
 * enum、minLength、maxLength、pattern、minimum、maximum、items）。AGENT 的工具执行端和 MCP 服务器
 * 用它检查模型给的参数：不合格时返回带路径的错误，交回模型（is_error / isError），模型可以据此改了再调。
 *
 * 不是完整实现：$ref、组合关键字（anyOf / oneOf / allOf）、format 都不支持，遇到会报错而不是悄悄放行。
 */

export type JsonType = 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';

export interface JsonSchema {
  type?: JsonType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: readonly (string | number | boolean)[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  [key: string]: unknown;
}

export interface SchemaError {
  /** 出错的位置，写成 `order_id`、`items[0].sku`；根是空串。 */
  path: string;
  message: string;
}

const UNSUPPORTED = ['$ref', 'anyOf', 'oneOf', 'allOf', 'not', 'if', 'format'];

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value as JsonType;
}

const join = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key);

/** 校验，返回全部错误（空数组表示通过）。错误按在 schema 里出现的顺序：先 required，再逐个属性。 */
export function validate(schema: JsonSchema, value: unknown, path = ''): SchemaError[] {
  for (const key of UNSUPPORTED) if (key in schema) throw new Error(`本站的校验器不支持 ${key}`);
  const errors: SchemaError[] = [];
  const actual = typeOf(value);
  if (schema.type) {
    const ok = schema.type === actual || (schema.type === 'number' && actual === 'integer');
    if (!ok) return [{ path, message: `应为 ${schema.type}，实际是 ${actual}` }];
  }
  if (schema.enum && !schema.enum.includes(value as string)) errors.push({ path, message: `只能是 ${schema.enum.map((item) => JSON.stringify(item)).join('、')} 之一` });
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) errors.push({ path, message: `至少 ${schema.minLength} 个字符` });
    if (schema.maxLength !== undefined && length > schema.maxLength) errors.push({ path, message: `最多 ${schema.maxLength} 个字符` });
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, message: `不匹配 ${schema.pattern}` });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `不能小于 ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `不能大于 ${schema.maximum}` });
  }
  if (actual === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) errors.push({ path: join(path, key), message: '缺少必填参数' });
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in object) errors.push(...validate(sub, object[key], join(path, key)));
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) if (!(key in (schema.properties ?? {}))) errors.push({ path: join(path, key), message: '不认识的参数' });
    }
  }
  if (actual === 'array' && schema.items) (value as unknown[]).forEach((item, i) => errors.push(...validate(schema.items!, item, join(path, i))));
  return errors;
}

/** 错误写成一行给模型看：`order_id：缺少必填参数；amount：应为 number，实际是 string`。 */
export const formatErrors = (errors: readonly SchemaError[]): string => errors.map((error) => `${error.path || '参数'}：${error.message}`).join('；');
