import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { decodeJson, encodeJson, fromBase64, stableStringify, toBase64 } from '../src/index';

test('keys are written in sorted order, at every depth', () => {
  assert.equal(stableStringify({ b: 1, a: { d: [1, { z: 0, y: 'é' }], c: null } }), '{"a":{"c":null,"d":[1,{"y":"é","z":0}]},"b":1}');
});

test('undefined object fields are skipped and undefined array items become null, as in JSON.stringify', () => {
  assert.equal(stableStringify({ a: undefined, b: [undefined, 1] }), '{"b":[null,1]}');
});

test('values JSON cannot represent faithfully are rejected', () => {
  assert.throws(() => encodeJson({ a: NaN }), /NaN at a/);
  assert.throws(() => encodeJson([Infinity]), /Infinity at 0/);
  assert.throws(() => encodeJson({ m: new Map() }), /Map at m/);
  assert.throws(() => encodeJson({ d: new Uint8Array(1) }), /Uint8Array at d/);
  assert.throws(() => encodeJson(() => 1), /function/);
});

test('decodeJson rejects invalid UTF-8', () => {
  assert.throws(() => decodeJson(new Uint8Array([0x7b, 0xff, 0x7d])));
});

test('property: decode(encode(v)) equals v and the bytes match JSON.stringify in length', () => {
  fc.assert(
    fc.property(fc.jsonValue({ noUnicodeString: false }), (v) => {
      const bytes = encodeJson(v);
      assert.deepEqual(decodeJson(bytes), JSON.parse(JSON.stringify(v)));
      assert.equal(bytes.length, new TextEncoder().encode(JSON.stringify(v)).length);
    }),
    { seed: 1, numRuns: 500 },
  );
});

test('property: key insertion order does not change the bytes', () => {
  fc.assert(
    fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (obj) => {
      const reversed = Object.fromEntries(Object.entries(obj).reverse());
      assert.deepEqual(encodeJson(reversed), encodeJson(obj));
    }),
    { seed: 2, numRuns: 300 },
  );
});

test('base64 matches Node and round-trips', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 64 }), (bytes) => {
      const text = toBase64(bytes);
      assert.equal(text, Buffer.from(bytes).toString('base64'));
      assert.deepEqual(fromBase64(text), bytes);
    }),
    { seed: 3, numRuns: 500 },
  );
  assert.throws(() => fromBase64('abc'), /invalid base64/);
  assert.throws(() => fromBase64('ab$='), /invalid base64/);
});
