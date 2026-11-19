// Exact, compact save encoding for arrays of doubles: little-endian IEEE-754 bytes in base64 (10.7 characters per
// number instead of ~18 for JSON's shortest round-trip text). Bit-exact both ways, including −0, ±∞ and NaN.
// Pure, no DOM (no btoa/atob), deterministic. Used at save/load time only (allocates; never in a step path).
//
// WIRING: sensors.ts saveSensors/loadSensors (W3-C). Any package may use it for its own save fields.

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const REV = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) REV[ABC.charCodeAt(i)] = i;

export function packF64(values: ArrayLike<number>): string {
  const n = values.length, bytes = new Uint8Array(8 * n), dv = new DataView(bytes.buffer);
  for (let i = 0; i < n; i++) dv.setFloat64(8 * i, values[i], true);
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const v = (b0 << 16) | (b1 << 8) | b2;
    s += ABC[(v >> 18) & 63] + ABC[(v >> 12) & 63];
    s += i + 1 < bytes.length ? ABC[(v >> 6) & 63] : '=';
    s += i + 2 < bytes.length ? ABC[v & 63] : '=';
  }
  return s;
}

/** Inverse of packF64; null on malformed input. */
export function unpackF64(s: unknown): number[] | null {
  if (typeof s !== 'string' || s.length % 4 !== 0) return null;
  let pad = 0;
  if (s.endsWith('==')) pad = 2; else if (s.endsWith('=')) pad = 1;
  const nb = (s.length / 4) * 3 - pad;
  if (nb % 8 !== 0) return null;
  const bytes = new Uint8Array(nb);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) {
      const ch = s.charCodeAt(i + k);
      const d = ch === 61 ? 0 : ch < 128 ? REV[ch] : -1;
      if (d < 0) return null;
      v = (v << 6) | d;
    }
    if (o < nb) bytes[o++] = (v >> 16) & 255;
    if (o < nb) bytes[o++] = (v >> 8) & 255;
    if (o < nb) bytes[o++] = v & 255;
  }
  const dv = new DataView(bytes.buffer), out: number[] = [];
  for (let i = 0; i < nb; i += 8) out.push(dv.getFloat64(i, true));
  return out;
}
