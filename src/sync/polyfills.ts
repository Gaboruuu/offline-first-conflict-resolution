/**
 * Globals sync-core expects but Hermes (React Native's engine) may lack. Imported first by the root
 * layout, before any sync-core module runs. Each one is installed only when missing.
 */

/** UTF-8 only, which is all sync-core's codec uses; `fatal: true` rejects malformed input like the standard one. */
class Utf8Decoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM = false;

  constructor(label = 'utf-8', options: { fatal?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`Unsupported encoding ${label}`);
    this.fatal = options.fatal ?? false;
  }

  decode(input?: ArrayBufferView | ArrayBuffer): string {
    if (!input) return '';
    const bytes =
      input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return decodeUtf8(bytes, this.fatal);
  }
}

export function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  let out = '';
  let i = 0;
  const bad = () => {
    if (fatal) throw new TypeError('The encoded data was not valid utf-8');
    out += '�';
  };
  while (i < bytes.length) {
    const b0 = bytes[i];
    let need = 0;
    let cp = 0;
    let min = 0;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1; cp = b0 & 0x1f; min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2; cp = b0 & 0x0f; min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3; cp = b0 & 0x07; min = 0x10000;
    } else {
      bad();
      i++;
      continue;
    }
    let j = 1;
    for (; j <= need; j++) {
      const b = bytes[i + j];
      if (b === undefined || (b & 0xc0) !== 0x80) break;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (j <= need || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      bad();
      i += Math.max(1, j);
      continue;
    }
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}

const g = globalThis as { TextDecoder?: unknown };
if (typeof g.TextDecoder === 'undefined') g.TextDecoder = Utf8Decoder;
