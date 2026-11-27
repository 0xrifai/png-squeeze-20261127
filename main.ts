// PNG Squeeze — optimal-parse deflate, palette and filter search.
//
// Lossless PNG compressor for 1280x720 screenshots. For each image it decodes
// the stored input PNG, analyses the pixels (opaque / grey / distinct colours /
// transparent colours), builds several exact colour-type forms (palette in three
// orderings, grey, grey+alpha, RGB, RGBA, tRNS-key), searches per-row filters for
// each form, screens the candidates with zlib level 6, then re-compresses the best
// ones with zlib level 9 and with our own optimal-parse DEFLATE (hash-chain LZ77
// plus shortest-path dynamic programming over the filtered bytes, iterated Huffman
// tables, dynamic/fixed/stored block choice) and writes the smallest finished PNG.
//
// Everything is deterministic: no clock reads, no randomness, no time-based
// cutoffs, so two runs produce byte-identical outputs. Node 22, built-ins only.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync, deflateRawSync } from 'node:zlib';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Tunables for the optimal-parse deflate (work-budgeted, never clock-budgeted).
// Chain depth is set by stream size: points per byte are far higher on the
// small-scale instances (palette/grey streams near 1 MB), so those get the
// deep search, while the multi-MB RGB/RGBA streams keep a shallow one.
const OPT_ITERS = 1; // DP passes per block (first pass uses fixed-Huffman costs)
const OPT_BLOCK = 200000; // max input bytes per DEFLATE block
function optChain(n: number): number { return n <= 1000000 ? 2048 : 256; }

// ---------------------------------------------------------------------------
// Checksums
// ---------------------------------------------------------------------------
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG decoding: 8-bit, non-interlaced, colour types 0/2/3/4/6 -> RGBA pixels.
// ---------------------------------------------------------------------------
function decodePng(buf: Buffer): { w: number; h: number; px: Uint8Array } {
  let off = 8, w = 0, h = 0, ct = 0, plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = ct === 0 ? 1 : ct === 2 ? 3 : ct === 3 ? 1 : ct === 4 ? 2 : 4;
  const stride = w * ch;
  const px = new Uint8Array(w * h * 4);
  let p = 0;
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 255;
      else if (f === 2) v = (v + b) & 255;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
    prev.set(cur);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4, s = x * ch;
      if (ct === 6) { px[o] = cur[s]; px[o + 1] = cur[s + 1]; px[o + 2] = cur[s + 2]; px[o + 3] = cur[s + 3]; }
      else if (ct === 2) { px[o] = cur[s]; px[o + 1] = cur[s + 1]; px[o + 2] = cur[s + 2]; px[o + 3] = 255; }
      else if (ct === 0) { px[o] = px[o + 1] = px[o + 2] = cur[s]; px[o + 3] = 255; }
      else if (ct === 4) { px[o] = px[o + 1] = px[o + 2] = cur[s]; px[o + 3] = cur[s + 1]; }
      else if (ct === 3 && plte) {
        const i = cur[s] * 3;
        px[o] = plte[i]; px[o + 1] = plte[i + 1]; px[o + 2] = plte[i + 2];
        px[o + 3] = trns ? (trns[cur[s]] ?? 255) : 255;
      }
    }
  }
  return { w, h, px };
}

// ---------------------------------------------------------------------------
// Per-row PNG filters (filter byte + filtered bytes for one row).
// ---------------------------------------------------------------------------
function filterRow(raw: Uint8Array, prev: Uint8Array | null, bpp: number, f: number): Uint8Array {
  const out = new Uint8Array(raw.length);
  for (let x = 0; x < raw.length; x++) {
    const a = x >= bpp ? raw[x - bpp] : 0, b = prev ? prev[x] : 0, c = x >= bpp && prev ? prev[x - bpp] : 0;
    let pr = 0;
    if (f === 1) pr = a;
    else if (f === 2) pr = b;
    else if (f === 3) pr = (a + b) >> 1;
    else if (f === 4) {
      const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[x] = (raw[x] - pr) & 255;
  }
  return out;
}

// Score a filtered row cheaply: sum of absolute signed byte values.
function rowCost(fr: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < fr.length; i++) { const v = fr[i]; s += v < 128 ? v : 256 - v; }
  return s;
}

// Build the filtered byte stream for a plane under one filter mode.
// Modes: 0..4 = one fixed filter for every row; 5 = per-row minimum-sum;
// 6 = per-row fewest distinct byte pairs (a pair is two neighbouring bytes:
// the count of distinct pairs tracks how many different two-byte sequences
// the deflater must encode, which follows its cost better than a byte sum).
function filterPlane(plane: Uint8Array, w: number, h: number, bpp: number, mode: number): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array(h * (stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  let prevRaw: Uint8Array | null = null;
  for (let y = 0; y < h; y++) {
    const raw = plane.subarray(y * stride, (y + 1) * stride);
    let f = mode;
    if (mode === 5 || mode === 6) {
      let best = Infinity;
      for (let cand = 0; cand < 5; cand++) {
        const fr = filterRow(raw, prevRaw, bpp, cand);
        let s: number;
        if (mode === 5) s = rowCost(fr);
        else {
          stamp++;
          s = 0;
          for (let i = 1; i < fr.length; i++) {
            const pair = (fr[i - 1] << 8) | fr[i];
            if (seen[pair] !== stamp) { seen[pair] = stamp; s++; }
          }
        }
        if (s < best) { best = s; f = cand; }
      }
    }
    const fr = filterRow(raw, prevRaw, bpp, f);
    out[y * (stride + 1)] = f;
    out.set(fr, y * (stride + 1) + 1);
    prevRaw = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pixel analysis and exact colour-type forms.
// A form is one lossless repacking of the pixels: a colour type, bytes per
// pixel, the unfiltered plane, and optional PLTE / tRNS chunks.
// ---------------------------------------------------------------------------
type Form = {
  name: string;
  colorType: number;
  bpp: number;
  plane: Uint8Array;
  plte?: Uint8Array;
  trns?: Uint8Array;
};

function analyse(px: Uint8Array): {
  ncolors: number; opaque: boolean; grey: boolean;
  colors: Map<number, number>; transRgb: Set<number>;
} {
  const colors = new Map<number, number>();
  const transRgb = new Set<number>();
  let opaque = true, grey = true;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
    if (a < 255) { opaque = false; transRgb.add((r << 16) | (g << 8) | b); }
    if (r !== g || g !== b) grey = false;
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    colors.set(key, (colors.get(key) ?? 0) + 1);
  }
  return { ncolors: colors.size, opaque, grey, colors, transRgb };
}

function luminance(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

// Greedy nearest-neighbour palette ordering: start from the most frequent
// colour, then repeatedly append the unused colour closest in RGBA space.
// Similar colours end up adjacent, which shrinks Sub-filter residuals.
function orderGreedy(entries: { key: number; count: number }[]): number[] {
  const n = entries.length;
  const used = new Uint8Array(n);
  const order: number[] = [];
  let cur = 0;
  for (let i = 1; i < n; i++) if (entries[i].count > entries[cur].count) cur = i;
  order.push(cur); used[cur] = 1;
  const comp = (k: number): [number, number, number, number] => [
    (k >>> 24) & 255, (k >>> 16) & 255, (k >>> 8) & 255, k & 255,
  ];
  while (order.length < n) {
    const [cr, cg, cb, ca] = comp(entries[cur].key);
    let best = -1, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      const [r, g, b, a] = comp(entries[i].key);
      const d = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb) + (a - ca) * (a - ca) * 4;
      if (d < bestD) { bestD = d; best = i; }
    }
    order.push(best); used[best] = 1; cur = best;
  }
  return order;
}

function buildForms(px: Uint8Array, w: number, h: number): Form[] {
  const { ncolors, opaque, grey, colors, transRgb } = analyse(px);
  const npix = w * h;
  const forms: Form[] = [];

  // Palette forms (at most 256 distinct colours), in three orderings.
  // Transparent entries come first (by alpha) in the count and luminance
  // orderings, so the tRNS chunk stays short; a palette holds the image in
  // a third of the bytes of RGB or less, so when it applies to a non-grey
  // image no RGB/RGBA form is tried at all.
  if (ncolors <= 256) {
    const entries = [...colors.entries()].map(([key, count]) => ({ key, count }));
    const alphaOf = (k: number): number => k & 255;
    const transFirst = (a: number, b: number): number => {
      const ta = alphaOf(entries[a].key) === 255 ? 1 : 0, tb = alphaOf(entries[b].key) === 255 ? 1 : 0;
      if (ta !== tb) return ta - tb;
      if (ta === 0 && alphaOf(entries[a].key) !== alphaOf(entries[b].key)) return alphaOf(entries[a].key) - alphaOf(entries[b].key);
      return 0;
    };
    const orderings: [string, number[]][] = [
      ['pal-count', entries.map((_, i) => i).sort((a, b) => transFirst(a, b) || entries[b].count - entries[a].count || entries[a].key - entries[b].key)],
      ['pal-lum', entries.map((_, i) => i).sort((a, b) => transFirst(a, b) || luminance((entries[a].key >>> 24) & 255, (entries[a].key >>> 16) & 255, (entries[a].key >>> 8) & 255) - luminance((entries[b].key >>> 24) & 255, (entries[b].key >>> 16) & 255, (entries[b].key >>> 8) & 255) || entries[a].key - entries[b].key)],
      ['pal-greedy', orderGreedy(entries)],
    ];
    for (const [name, order] of orderings) {
      const indexOf = new Map<number, number>();
      const plte = new Uint8Array(ncolors * 3);
      const trns = new Uint8Array(ncolors);
      let hasAlpha = false;
      for (let rank = 0; rank < order.length; rank++) {
        const e = entries[order[rank]];
        indexOf.set(e.key, rank);
        plte[rank * 3] = (e.key >>> 24) & 255;
        plte[rank * 3 + 1] = (e.key >>> 16) & 255;
        plte[rank * 3 + 2] = (e.key >>> 8) & 255;
        trns[rank] = e.key & 255;
        if ((e.key & 255) < 255) hasAlpha = true;
      }
      const plane = new Uint8Array(npix);
      for (let i = 0; i < npix; i++) {
        const o = i * 4;
        const key = ((px[o] << 24) | (px[o + 1] << 16) | (px[o + 2] << 8) | px[o + 3]) >>> 0;
        plane[i] = indexOf.get(key)!;
      }
      // Trim trailing fully-opaque tRNS entries: a tRNS chunk only needs to
      // cover entries up to the last one with alpha < 255.
      let tlen = ncolors;
      while (tlen > 0 && trns[tlen - 1] === 255) tlen--;
      forms.push({
        name, colorType: 3, bpp: 1, plane, plte,
        trns: hasAlpha ? trns.subarray(0, Math.max(tlen, 1)) : undefined,
      });
    }
  }

  // Grey forms (only when every pixel is grey). A palette image that is grey
  // is tried in both its palette and its grey forms.
  if (grey) {
    const plane = new Uint8Array(npix);
    for (let i = 0; i < npix; i++) plane[i] = px[i * 4];
    if (opaque) forms.push({ name: 'grey', colorType: 0, bpp: 1, plane });
    else {
      const planeA = new Uint8Array(npix * 2);
      for (let i = 0; i < npix; i++) { planeA[i * 2] = px[i * 4]; planeA[i * 2 + 1] = px[i * 4 + 3]; }
      forms.push({ name: 'grey-alpha', colorType: 4, bpp: 2, plane: planeA });
    }
    // Grey + single transparent key (tRNS holds one grey value).
    if (!opaque && transRgb.size === 1) {
      const [tv] = [...transRgb];
      const key = (tv >> 16) & 255;
      let ok = true;
      for (let i = 0; i < npix; i++) if (px[i * 4 + 3] === 255 && px[i * 4] === key) { ok = false; break; }
      if (ok) {
        const trns = new Uint8Array(2); trns[0] = 0; trns[1] = key;
        forms.push({ name: 'grey-trns', colorType: 0, bpp: 1, plane, trns });
      }
    }
  }

  // RGB / RGBA forms, plus an RGB + single-transparent-key form. Skipped when
  // a palette applies to a non-grey image (see above).
  if (ncolors <= 256 && !grey) return forms;
  if (opaque) {
    const plane = new Uint8Array(npix * 3);
    for (let i = 0; i < npix; i++) { plane[i * 3] = px[i * 4]; plane[i * 3 + 1] = px[i * 4 + 1]; plane[i * 3 + 2] = px[i * 4 + 2]; }
    forms.push({ name: 'rgb', colorType: 2, bpp: 3, plane });
  } else {
    forms.push({ name: 'rgba', colorType: 6, bpp: 4, plane: px.slice() });
    if (transRgb.size === 1) {
      const [tv] = [...transRgb];
      const tr = (tv >> 16) & 255, tg = (tv >> 8) & 255, tb = tv & 255;
      let ok = true;
      for (let i = 0; i < npix; i++) {
        if (px[i * 4 + 3] === 255 && px[i * 4] === tr && px[i * 4 + 1] === tg && px[i * 4 + 2] === tb) { ok = false; break; }
      }
      if (ok) {
        const plane = new Uint8Array(npix * 3);
        for (let i = 0; i < npix; i++) { plane[i * 3] = px[i * 4]; plane[i * 3 + 1] = px[i * 4 + 1]; plane[i * 3 + 2] = px[i * 4 + 2]; }
        const trns = new Uint8Array(6);
        trns[0] = 0; trns[1] = tr; trns[2] = 0; trns[3] = tg; trns[4] = 0; trns[5] = tb;
        forms.push({ name: 'rgb-trns', colorType: 2, bpp: 3, plane, trns });
      }
    }
  }
  return forms;
}

// ---------------------------------------------------------------------------
// Optimal-parse DEFLATE (written from the DEFLATE format itself: RFC 1951).
// LZ77 match search over hash chains, shortest-path (dynamic programming)
// parse under a bit-cost model, length-limited Huffman codes built from the
// parse's own frequencies, and dynamic / fixed / stored block choice per block.
// A block's winner is picked by its ACTUAL emitted size, header included.
// ---------------------------------------------------------------------------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const LEN_BOUNDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
function lenSym(len: number): number { for (let s = 28; s >= 0; s--) if (len >= LEN_BASE[s]) return s; return 0; }
function distSym(d: number): number { for (let s = 29; s >= 0; s--) if (d >= DIST_BASE[s]) return s; return 0; }

const FIXED_LIT_LEN = new Uint8Array(288);
const FIXED_DIST_LEN = new Uint8Array(30);
for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9;
for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7;
for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8;
for (let i = 0; i < 30; i++) FIXED_DIST_LEN[i] = 5;

// Length-limited Huffman code lengths from symbol frequencies: heap-built,
// clamped to maxBits, then the Kraft sum repaired to exactly 1 by integer
// arithmetic (moving one leaf down and one clamped leaf up per step lowers
// the sum by exactly 2^-maxBits), with a rank-based complete code as fallback.
function huffLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const len = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return len;
  if (syms.length === 1) { len[syms[0]] = 1; return len; }
  const items = syms.map((s) => ({ f: freq[s], syms: [s] }));
  while (items.length > 1) {
    items.sort((a, b) => a.f - b.f);
    const a = items.shift()!, b = items.shift()!;
    for (const s of a.syms) len[s]++;
    for (const s of b.syms) len[s]++;
    items.push({ f: a.f + b.f, syms: a.syms.concat(b.syms) });
  }
  for (const s of syms) if (len[s] > maxBits) len[s] = maxBits;
  const scale = 1 << maxBits;
  let snum = 0;
  for (const s of syms) snum += 1 << (maxBits - len[s]);
  let guard = 0;
  while (snum > scale && guard++ < 10000) {
    const cnt = new Array<number>(maxBits + 1).fill(0);
    for (const s of syms) cnt[len[s]]++;
    let m = maxBits - 1;
    while (m > 0 && cnt[m] === 0) m--;
    if (m === 0 || cnt[maxBits] === 0) break;
    let movedDown = false, movedUp = false;
    for (const s of syms) if (!movedDown && len[s] === m) { len[s] = m + 1; movedDown = true; }
    for (const s of syms) if (!movedUp && len[s] === maxBits) { len[s] = m + 1; movedUp = true; }
    if (!movedDown || !movedUp) break;
    snum -= 1;
  }
  let ok = true, chk = 0;
  for (const s of syms) { if (len[s] > maxBits || len[s] === 0) ok = false; chk += 1 << (maxBits - len[s]); }
  if (!ok || chk !== scale) {
    const byFreq = syms.slice().sort((a, b) => freq[b] - freq[a]);
    const k = byFreq.length;
    const L = Math.floor(Math.log2(k));
    const a = (1 << (L + 1)) - k;
    for (let r = 0; r < k; r++) len[byFreq[r]] = r < a ? L : L + 1;
    if (L === 0) { len[byFreq[0]] = 1; len[byFreq[1]] = 1; }
  }
  return len;
}

// Canonical Huffman codes, bit-reversed: DEFLATE writes Huffman codes
// most-significant-bit first while other fields go least-significant first.
function canonCodes(len: Uint8Array): Uint32Array {
  const n = len.length;
  const codes = new Uint32Array(n);
  const bl = new Array<number>(16).fill(0);
  for (let i = 0; i < n; i++) bl[len[i]]++;
  let code = 0;
  const next = new Array<number>(16).fill(0);
  for (let b = 1; b < 16; b++) { code = (code + bl[b - 1]) << 1; next[b] = code; }
  for (let i = 0; i < n; i++) if (len[i]) {
    const c = next[len[i]]++;
    let r = 0;
    for (let k = 0; k < len[i]; k++) r = (r << 1) | ((c >> k) & 1);
    codes[i] = r;
  }
  return codes;
}

// Bit writer over a growing byte list. Bits go in least-significant first,
// matching DEFLATE's packing for non-Huffman fields; Huffman codes are
// pre-reversed by canonCodes. Blocks continue mid-byte (only stored blocks
// align); totalBits counts meaningful bits, not padding.
class BW {
  out: number[] = [];
  acc = 0;
  nbits = 0;
  totalBits = 0;
  w(v: number, n: number): void {
    this.acc |= (v & ((1 << n) - 1)) << this.nbits;
    this.nbits += n;
    this.totalBits += n;
    while (this.nbits >= 8) { this.out.push(this.acc & 255); this.acc >>>= 8; this.nbits -= 8; }
  }
  flush(): void {
    if (this.nbits > 0) { this.out.push(this.acc & 255); this.acc = 0; this.nbits = 0; }
  }
  bytes(): Uint8Array { return Uint8Array.from(this.out); }
  append(o: BW): void {
    if (this.nbits === 0) {
      for (const b of o.out) this.out.push(b);
      if (o.nbits > 0) this.w(o.acc, o.nbits);
    } else {
      for (const b of o.out) this.w(b, 8);
      if (o.nbits > 0) this.w(o.acc, o.nbits);
    }
    this.totalBits += o.totalBits;
  }
}

type Sym = [number, number, number]; // [length, distance, literal byte]; distance 0 = literal

function deflateOptimal(data: Uint8Array): Uint8Array {
  const n = data.length;
  const chainLimit = optChain(n);
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  let inserted = 0;
  const bw = new BW();

  const emitBlock = (w: BW, useFixed: boolean, parse: Sym[], litLen: Uint8Array, distLen: Uint8Array, isLast: boolean): number => {
    w.w(isLast ? 1 : 0, 1);
    let llLen: Uint8Array, ddLen: Uint8Array, llCode: Uint32Array, ddCode: Uint32Array;
    if (useFixed) {
      w.w(1, 2); llLen = FIXED_LIT_LEN; ddLen = FIXED_DIST_LEN;
    } else {
      w.w(2, 2);
      let hlit = 29;
      while (hlit > 0 && litLen[256 + hlit] === 0) hlit--;
      hlit = Math.max(hlit, 0);
      let hdist = 29;
      while (hdist > 0 && distLen[hdist] === 0) hdist--;
      const HLIT = 257 + hlit, HDIST = 1 + hdist;
      const all = new Uint8Array(HLIT + HDIST);
      for (let i = 0; i < HLIT; i++) all[i] = litLen[i];
      for (let i = 0; i < HDIST; i++) all[HLIT + i] = distLen[i];
      const clFreq = new Uint32Array(19);
      const seq: [number, number][] = [];
      let idx = 0;
      while (idx < HLIT + HDIST) {
        const v = all[idx];
        let run = 1;
        while (idx + run < HLIT + HDIST && all[idx + run] === v) run++;
        if (v === 0) {
          let r = run;
          while (r >= 11) { const t = Math.min(r, 138); seq.push([18, t]); clFreq[18]++; r -= t; }
          if (r >= 3) { seq.push([17, r]); clFreq[17]++; }
          else if (r > 0) for (let k = 0; k < r; k++) { seq.push([0, 0]); clFreq[0]++; }
        } else {
          seq.push([v, 0]); clFreq[v]++;
          let r = run - 1;
          while (r >= 3) { const t = Math.min(r, 6); seq.push([16, t]); clFreq[16]++; r -= t; }
          for (let k = 0; k < r; k++) { seq.push([v, 0]); clFreq[v]++; }
        }
        idx += run;
      }
      const clLen = huffLengths(clFreq, 7);
      const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
      let hclen = 19;
      while (hclen > 4 && clLen[order[hclen - 1]] === 0) hclen--;
      w.w(HLIT - 257, 5); w.w(HDIST - 1, 5); w.w(hclen - 4, 4);
      for (let k = 0; k < hclen; k++) w.w(clLen[order[k]], 3);
      const clCode = canonCodes(clLen);
      for (const [sym, extra] of seq) {
        w.w(clCode[sym], clLen[sym]);
        if (sym === 16) w.w(extra - 3, 2);
        else if (sym === 17) w.w(extra - 3, 3);
        else if (sym === 18) w.w(extra - 11, 7);
      }
      llLen = litLen; ddLen = distLen;
    }
    llCode = canonCodes(llLen); ddCode = canonCodes(ddLen);
    for (const [l, dd, b] of parse) {
      if (dd === 0) w.w(llCode[b], llLen[b]);
      else {
        const s = lenSym(l);
        w.w(llCode[257 + s], llLen[257 + s]);
        const eb = LEN_EXT[s];
        if (eb) w.w(l - LEN_BASE[s], eb);
        const ds = distSym(dd);
        w.w(ddCode[ds], ddLen[ds]);
        const ed = DIST_EXT[ds];
        if (ed) w.w(dd - DIST_BASE[ds], ed);
      }
    }
    w.w(llCode[256], llLen[256]);
    return w.totalBits;
  };

  for (let bs = 0; bs < n; bs += OPT_BLOCK) {
    const be = Math.min(n, bs + OPT_BLOCK);
    const m = be - bs;
    const last = be === n;
    let litCost = new Float64Array(288);
    let lenCost = new Float64Array(29);
    let distCost = new Float64Array(30);
    for (let i = 0; i < 288; i++) litCost[i] = FIXED_LIT_LEN[i];
    for (let s = 0; s < 29; s++) lenCost[s] = FIXED_LIT_LEN[257 + s] + LEN_EXT[s];
    for (let s = 0; s < 30; s++) distCost[s] = 5 + DIST_EXT[s];
    let bestParse: { parse: Sym[]; litLen: Uint8Array; distLen: Uint8Array } | null = null;
    let bestBits = Infinity;
    const d = data;
    for (let it = 0; it < OPT_ITERS; it++) {
      // Rebuild the hash chains every pass: a previous pass's chains hold
      // positions ahead of the current DP position (negative distances).
      head.fill(-1); prev.fill(-1);
      inserted = bs - 32768; if (inserted < 0) inserted = 0;
      while (inserted < bs) {
        if (inserted + 2 < n) {
          const hh = (((d[inserted] << 10) ^ (d[inserted + 1] << 5) ^ d[inserted + 2]) * 2654435761) >>> 17 & 32767;
          prev[inserted] = head[hh]; head[hh] = inserted;
        }
        inserted++;
      }
      const dp = new Float64Array(m + 1).fill(Infinity);
      dp[0] = 0;
      const pLen = new Int32Array(m + 1);
      const pDist = new Int32Array(m + 1);
      const lc = litCost, ec = lenCost, dc = distCost;
      for (let i = 0; i < m; i++) {
        const g = bs + i;
        const base = dp[i];
        if (base === Infinity) continue;
        const litC = base + lc[d[g]];
        if (litC < dp[i + 1]) { dp[i + 1] = litC; pLen[i + 1] = 1; pDist[i + 1] = 0; }
        if (g + 2 < be) {
          const hg = (((d[g] << 10) ^ (d[g + 1] << 5) ^ d[g + 2]) * 2654435761) >>> 17 & 32767;
          prev[g] = head[hg]; head[hg] = g;
          let cur = prev[g];
          let bestLen = 2, chain = 0;
          const maxLen = be - g < 258 ? be - g : 258;
          let prevRec = 3;
          while (cur !== -1 && g - cur <= 32768 && chain < chainLimit) {
            const dist = g - cur;
            if (bestLen < maxLen && d[cur + bestLen] === d[g + bestLen]) {
              let l = 0;
              while (l < maxLen && d[cur + l] === d[g + l]) l++;
              if (l > bestLen) {
                bestLen = l;
                const dcc = dc[distSym(dist)];
                for (let bi = 0; bi < 29; bi++) {
                  const b = LEN_BOUNDS[bi];
                  if (b < prevRec) continue;
                  if (b > l) break;
                  const cc = base + ec[lenSym(b)] + dcc;
                  if (cc < dp[i + b]) { dp[i + b] = cc; pLen[i + b] = b; pDist[i + b] = dist; }
                }
                const cc2 = base + ec[lenSym(l)] + dcc;
                if (cc2 < dp[i + l]) { dp[i + l] = cc2; pLen[i + l] = l; pDist[i + l] = dist; }
                prevRec = l + 1;
                if (l >= maxLen) break;
              }
            }
            cur = prev[cur]; chain++;
            if (bestLen >= 32 && chain > (chainLimit >> 2)) break;
          }
        }
      }
      const parse: Sym[] = [];
      let i = m;
      while (i > 0) {
        const l = pLen[i], dd = pDist[i];
        if (dd === 0) parse.push([1, 0, d[bs + i - 1]]);
        else parse.push([l, dd, 0]);
        i -= l;
      }
      parse.reverse();
      const lf = new Uint32Array(288);
      const df = new Uint32Array(30);
      for (let k = 0; k < parse.length; k++) {
        const e = parse[k];
        if (e[1] === 0) lf[e[2]]++;
        else { lf[257 + lenSym(e[0])]++; df[distSym(e[1])]++; }
      }
      lf[256]++;
      const litLen = huffLengths(lf, 15);
      const distLen = huffLengths(df, 15);
      let hasMatch = false;
      for (let q = 0; q < 30; q++) if (df[q] > 0) { hasMatch = true; break; }
      if (!hasMatch) { distLen[0] = 1; distLen[1] = 1; }
      const newLit = new Float64Array(288);
      const newLen = new Float64Array(29);
      const newDist = new Float64Array(30);
      for (let s = 0; s < 288; s++) newLit[s] = litLen[s] || 11;
      for (let s = 0; s < 29; s++) newLen[s] = (litLen[257 + s] || 11) + LEN_EXT[s];
      for (let s = 0; s < 30; s++) newDist[s] = distLen[s] || 8;
      litCost = newLit; lenCost = newLen; distCost = newDist;
      // Pick by actual emitted size (header included): dp estimates from
      // different passes use different cost models and are incomparable.
      const probe = new BW();
      const probeBits = emitBlock(probe, false, parse, litLen, distLen, last);
      if (probeBits < bestBits) { bestBits = probeBits; bestParse = { parse, litLen, distLen }; }
    }
    const bp = bestParse!;
    const tmpDyn = new BW();
    const dynBits = emitBlock(tmpDyn, false, bp.parse, bp.litLen, bp.distLen, last);
    const tmpFix = new BW();
    const fixBits = emitBlock(tmpFix, true, bp.parse, bp.litLen, bp.distLen, last);
    const useDyn = dynBits <= fixBits;
    const chosenBits = useDyn ? dynBits : fixBits;
    const storedLen = 5 * Math.ceil(m / 65535) + m;
    if (storedLen * 8 < chosenBits) {
      if (bw.nbits > 0) { bw.out.push(bw.acc & 255); bw.acc = 0; bw.nbits = 0; }
      let off = bs;
      while (off < be) {
        const chunk = Math.min(65535, be - off);
        const isLast = last && off + chunk === be;
        bw.out.push(isLast ? 1 : 0);
        bw.out.push(chunk & 255, (chunk >> 8) & 255, (~chunk) & 255, ((~chunk) >> 8) & 255);
        for (let k = 0; k < chunk; k++) bw.out.push(data[off + k]);
        off += chunk;
      }
      bw.totalBits = bw.out.length * 8;
    } else {
      bw.append(useDyn ? tmpDyn : tmpFix);
    }
  }
  bw.flush();
  return bw.bytes();
}

// ---------------------------------------------------------------------------
// PNG writing: IHDR, PLTE, tRNS, one IDAT holding a single zlib stream, IEND.
// ---------------------------------------------------------------------------
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Full pipeline for one image: screen forms/filters, final-deflate the best,
// and return the finished PNG bytes. `filteredOf` carries the filtered stream
// for the Adler32 (kept beside the deflate output to avoid recomputation).
function compressImage(px: Uint8Array, w: number, h: number): Uint8Array {
  const forms = buildForms(px, w, h);
  type Cand = { form: Form; mode: number; filtered: Uint8Array; z6: number };
  const cands: Cand[] = [];
  // Fixed filters 0..4 (None matters: it preserves exact row repetitions for
  // LZ77), then the per-row minimum-sum and fewest-pairs heuristics.
  const FILTER_MODES = [0, 1, 2, 3, 4, 5, 6];
  for (const form of forms) {
    const chunks = (form.plte ? 12 + form.plte.length : 0) + (form.trns ? 12 + form.trns.length : 0);
    for (const mode of FILTER_MODES) {
      const filtered = filterPlane(form.plane, w, h, form.bpp, mode);
      const z6 = deflateSync(filtered, { level: 6 }).length + chunks;
      cands.push({ form, mode, filtered, z6 });
    }
  }
  cands.sort((a, b) => a.z6 - b.z6);


  // Final deflate: zlib level 9 (memory levels 8 and 9) on the best three,
  // and the optimal-parse deflate on the best one. Smallest finished PNG wins.
  let best: { bytes: Uint8Array; form: Form; filtered: Uint8Array } | null = null;
  const consider = (form: Form, filtered: Uint8Array, raw: Uint8Array): void => {
    const png = finishPng(w, h, form, filtered, raw);
    if (!best || png.length < best.bytes.length) best = { bytes: png, form, filtered };
  };
  const top = cands.slice(0, 3);
  for (const c of top) {
    consider(c.form, c.filtered, deflateRawSync(c.filtered, { level: 9, memLevel: 9 }));
  }
  consider(top[0].form, top[0].filtered, deflateRawSync(top[0].filtered, { level: 9, memLevel: 8 }));
  const winner = top[0];
  consider(winner.form, winner.filtered, deflateOptimal(winner.filtered));
  return best!.bytes;
}

// Assemble the PNG: zlib header + raw deflate + Adler32 of the filtered bytes.
function finishPng(w: number, h: number, form: Form, filtered: Uint8Array, rawDeflate: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = form.colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const z = new Uint8Array(rawDeflate.length + 6);
  z[0] = 0x78; z[1] = 0x01;
  z.set(rawDeflate, 2);
  new DataView(z.buffer).setUint32(2 + rawDeflate.length, adler32(filtered));
  const parts: Uint8Array[] = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
  ];
  if (form.plte) parts.push(chunk('PLTE', form.plte));
  if (form.trns) parts.push(chunk('tRNS', form.trns));
  parts.push(chunk('IDAT', z));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// Main: every instance under the input dir, answers under the output dir.
// ---------------------------------------------------------------------------
for (const id of readdirSync(INPUT_DIR).sort()) {
  const src = join(INPUT_DIR, id, 'image.png');
  const { w, h, px } = decodePng(readFileSync(src));
  const png = compressImage(px, w, h);
  const dir = join(OUTPUT_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'image.png'), png);
}
