import { decodeJson, encodeJson } from '../codec';
import type { ReplicaId } from '../model';
import type { StrategyName } from '../strategy';

/**
 * Container for the saved state of the library-backed strategies (S3): a 4-byte big-endian length, a JSON
 * header, then the raw binary parts it lists. Binary rather than base64 inside JSON, so that `stateBytes`
 * measures the library's own format.
 */
interface Header {
  strategy: StrategyName;
  replicaId: ReplicaId;
  /** Name and byte length of each part, in order. */
  parts: { name: string; length: number }[];
}

export function pack(strategy: StrategyName, replicaId: ReplicaId, names: string[], parts: Uint8Array[]): Uint8Array {
  const header: Header = { strategy, replicaId, parts: names.map((name, i) => ({ name, length: parts[i]!.length })) };
  const head = encodeJson(header);
  const out = new Uint8Array(4 + head.length + parts.reduce((n, p) => n + p.length, 0));
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let offset = 4 + head.length;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function unpack(
  strategy: StrategyName,
  bytes: Uint8Array,
): { replicaId: ReplicaId; parts: Map<string, Uint8Array> } {
  let header: Header;
  let offset: number;
  try {
    const headLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    header = decodeJson<Header>(bytes.subarray(4, 4 + headLength));
    offset = 4 + headLength;
  } catch {
    throw new Error(`not a ${strategy} state`);
  }
  if (header.strategy !== strategy) throw new Error(`not a ${strategy} state: ${String(header.strategy)}`);
  const parts = new Map<string, Uint8Array>();
  for (const p of header.parts) {
    parts.set(p.name, bytes.slice(offset, offset + p.length));
    offset += p.length;
  }
  return { replicaId: header.replicaId, parts };
}
