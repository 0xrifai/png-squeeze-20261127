# PNG Squeeze — optimal-parse deflate, palette and filter search

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/0xrifai/png-squeeze-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/0xrifai/png-squeeze-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

A lossless PNG compressor that squeezes 1280×720 screenshots into the
smallest possible PNG. It decodes each stored input PNG, analyses the
pixels (opaque, grey, distinct colours, transparent colours), then screens
several exact forms — palette by count, by luminance and by a greedy
nearest-neighbour ordering, grey / grey+alpha, RGB / RGBA and tRNS-key
forms — each under several per-row filter choices (all five fixed filters,
minimum-sum and fewest-distinct-pairs heuristics, plus a brute-force
per-row search on the best form), and writes the winner with the smallest
of zlib level 9 and our own optimal-parse DEFLATE. Everything is
deterministic: the same input always produces the same bytes, with no
clock reads and no time-based cutoffs, so two runs agree byte for byte.

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

It reads `/input/<id>/image.png` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/image.png` (or `$MAKEFUN_OUTPUT_DIR`), creating each
output directory. Node 22, built-ins only, nothing to install.

## How it wins bytes

Screenshots are mostly flat colour, text and gradients, so the biggest
wins come from picking the right colour type: a palette of at most 256
colours costs a third of RGB, grey costs a third of RGBA, and a single
transparent colour can be carried as a tiny tRNS key instead of a whole
alpha channel. The unfiltered form matters too: on captures over a
transparent background, leaving rows unfiltered preserves exact row
repetitions that LZ77 turns into long matches, which the per-row
heuristics would otherwise break up. Ordering palette entries so similar
colours sit next to each other shrinks Sub-filter residuals, and a
brute-force per-row filter search (each filter deflated at level 6
against the previous 32 KiB) finds rows where a plain heuristic picks
wrong.

## The optimal-parse deflate

The final squeeze comes from a from-scratch DEFLATE in the manner of
zopfli, written here in TypeScript with no dependencies. For each block
of up to 200,000 filtered bytes it searches LZ77 matches with hash
chains (3-byte hash, bounded depth — deep for the small palette/grey
streams, where points per byte are highest, shallow for the multi-MB
RGB/RGBA streams), then runs a shortest-path dynamic program over the
bytes under a bit-cost model (literal and match costs from the current
Huffman lengths, starting from the fixed tables), rebuilds the
length-limited Huffman codes from the parse's own frequencies, and
emits the block as dynamic, fixed or stored, whichever is actually
smallest including its header. A block's winner is picked by real
emitted size, never by the dynamic program's estimate, because estimates
from different cost models are not comparable. The result beats zlib
level 9 by roughly 5–9% on the filtered screenshot streams.

Practice-set score (kit scorer, all 8 instances exact): **727,019**,
against the house fixed-paeth baseline's 420,399. Two runs agree byte
for byte; the whole set runs in about 46 seconds, inside the 60-second
wall.

## Licence

MIT — see `LICENSE`.

---

Built for the [make.fun](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty “Squeeze screenshots into the smallest PNG, 27 November 2026”.
[Sign up with my referral link](https://make.fun/?ref=6twtfdad)
