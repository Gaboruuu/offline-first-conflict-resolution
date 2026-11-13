/**
 * The one JSON codec used by every strategy that serialises its own messages and state (S1, S2, S4).
 * Object keys are written in sorted order, so equal values always produce identical bytes and byte
 * counts in the experiments are deterministic.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** JSON text with object keys in sorted (UTF-16 code unit) order and no whitespace. */
export function stableStringify(value: unknown): string {
  return write(value, []);
}

function write(value: unknown, path: string[]): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`cannot encode ${value} at ${where(path)}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => (v === undefined ? 'null' : write(v, [...path, String(i)]))).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`cannot encode ${(value as object).constructor?.name ?? 'object'} at ${where(path)}`);
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const v = record[key];
        if (v === undefined) continue; // same as JSON.stringify
        parts.push(`${JSON.stringify(key)}:${write(v, [...path, key])}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new TypeError(`cannot encode ${typeof value} at ${where(path)}`);
  }
}

function where(path: string[]): string {
  return path.length === 0 ? '(root)' : path.join('.');
}

/** UTF-8 bytes of `stableStringify(value)`. */
export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(stableStringify(value));
}

/** Inverse of `encodeJson`. Throws on invalid UTF-8 or invalid JSON. */
export function decodeJson<T = Json>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/**
 * Standard base64 (RFC 4648, with padding). Implemented here because neither `Buffer` (Node only)
 * nor `btoa` (binary strings only) is available everywhere sync-core runs. Used by the HTTP transport.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += b1 === undefined ? '=' : B64[(n >> 6) & 63]!;
    out += b2 === undefined ? '=' : B64[n & 63]!;
  }
  return out;
}

export function fromBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new SyntaxError('invalid base64');
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n =
      (B64_INDEX.get(text[i]!)! << 18) |
      (B64_INDEX.get(text[i + 1]!)! << 12) |
      ((B64_INDEX.get(text[i + 2]!) ?? 0) << 6) |
      (B64_INDEX.get(text[i + 3]!) ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}
