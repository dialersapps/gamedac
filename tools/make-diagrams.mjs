// Static diagrams for the README and the blog post. node tools/make-diagrams.mjs
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const docs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const STYLE = '<style>text{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;fill:#e6ecf5}.dim{fill:#9fb4cc}.box{fill:#14202e;stroke:#3b5a7c;stroke-width:1.5}.ok{fill:#1a2c1f;stroke:#4f8a5e;stroke-width:1.5}.hot{fill:#2a2216;stroke:#a67c2e;stroke-width:1.5}.arrow{stroke:#7fa6cf;stroke-width:2;fill:none;marker-end:url(#a)}</style><defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#7fa6cf"/></marker></defs><rect width="100%" height="100%" rx="10" fill="#0b0f14" stroke="#24364a"/>';
const wrap = (vb, title, desc, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" role="img" aria-labelledby="t d"><title id="t">${title}</title><desc id="d">${desc}</desc>${STYLE}${body}</svg>`;
const box = (x, y, w, h, l1, l2, cls = 'box') => `<rect class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="8"/><text x="${x + w / 2}" y="${y + (l2 ? h / 2 - 3 : h / 2 + 5)}" text-anchor="middle" font-size="13.5" font-weight="600">${l1}</text>${l2 ? `<text class="dim" x="${x + w / 2}" y="${y + h / 2 + 15}" text-anchor="middle" font-size="11">${l2}</text>` : ''}`;

// 1) the shared encoder shape
fs.writeFileSync(path.join(docs, 'pipeline.svg'), wrap('0 0 760 320', 'How gamedac encodes a block', 'Samples are cut into small blocks. For each block the encoder tries every predictor and scale the format allows, decodes each trial exactly as the real decoder would, keeps the one with the smallest error, and writes the nibbles, the choice and a header. Because the trial uses the decoder\'s own arithmetic, what you hear is what the encoder measured.',
  `<text x="20" y="26" font-size="14" font-weight="600">How a block is encoded (the same idea for every format)</text>
  ${box(20, 50, 150, 58, 'PCM samples', 'float or Int16, 1 or 2 ch')}<path class="arrow" d="M170,79 L206,79"/>
  ${box(208, 50, 170, 58, 'Cut into blocks', '14, 28 or 32 samples')}<path class="arrow" d="M378,79 L414,79"/>
  ${box(416, 50, 150, 58, 'For every trial', 'predictor x scale')}<path class="arrow" d="M566,79 L602,79"/>
  ${box(604, 50, 136, 58, 'Predict', 'from the last 2 outputs', 'hot')}
  <path class="arrow" d="M672,108 L672,142"/>
  ${box(604, 144, 136, 58, 'Quantise to 4 bits', 'round the residual', 'hot')}<path class="arrow" d="M604,173 L568,173"/>
  ${box(380, 144, 186, 58, 'Decode the trial', 'with the decoder\'s own arithmetic', 'hot')}<path class="arrow" d="M380,173 L344,173"/>
  ${box(168, 144, 176, 58, 'Keep the smallest error', 'across all trials')}
  <path class="arrow" d="M256,202 L256,236"/>
  ${box(168, 238, 176, 58, 'Write the block', 'choice + 4-bit codes', 'ok')}<path class="arrow" d="M168,267 L132,267"/>
  ${box(20, 238, 112, 58, 'Container', 'header, loops, CRC', 'ok')}
  <text class="dim" x="372" y="250" font-size="11.5">Closed loop: each block starts from the decoder state</text>
  <text class="dim" x="372" y="266" font-size="11.5">the previous block left, so errors do not pile up.</text>
  <text class="dim" x="372" y="286" font-size="11.5">DSP also analyses the whole clip first to choose its</text>
  <text class="dim" x="372" y="302" font-size="11.5">8 predictor pairs. ADX picks a step, not a filter.</text>`));

// 2) block layouts, to scale within each row
const row = (y, name, sub, total, parts) => { let x = 170; const W = 560; let s = `<text x="20" y="${y + 20}" font-size="13" font-weight="600">${name}</text><text class="dim" x="20" y="${y + 36}" font-size="10.5">${sub}</text>`; for (const [bytes, label, cls] of parts) { const w = (bytes / total) * W; s += `<rect class="${cls}" x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="40" rx="4"/><text x="${(x + w / 2).toFixed(1)}" y="${y + 24}" text-anchor="middle" font-size="${w < 60 ? 9.5 : 11.5}">${label}</text>`; x += w; } return s; };
fs.writeFileSync(path.join(docs, 'block-layouts.svg'), wrap('0 0 760 330', 'Block layouts of the formats', 'The unit each format encodes: PlayStation VAG uses 16-byte blocks of 28 samples, Nintendo DSP 8-byte frames of 14 samples, CRI ADX 18-byte blocks of 32 samples, and CD-ROM XA 128-byte sound groups with 16 bytes of parameters. Yamaha AICA and OKI ADPCM have no blocks at all: just a stream of 4-bit codes.',
  `<text x="20" y="26" font-size="14" font-weight="600">What one block looks like (widths to scale within a row)</text>
  ${row(48, 'PlayStation VAG', '16 bytes = 28 samples', 16, [[1, 'f|r', 'hot'], [1, 'flag', 'box'], [14, '28 four-bit codes', 'ok']])}
  ${row(98, 'Nintendo DSP', '8 bytes = 14 samples', 8, [[1, 'p|s', 'hot'], [7, '14 four-bit codes', 'ok']])}
  ${row(148, 'CRI ADX', '18 bytes = 32 samples', 18, [[2, 'step', 'hot'], [16, '32 four-bit codes', 'ok']])}
  ${row(198, 'CD-ROM XA', '128 bytes = 8 units x 28', 128, [[16, 'params', 'hot'], [112, '112 bytes: 28 words of 4 bytes, the 8 units interleaved', 'ok']])}
  ${row(248, 'Yamaha AICA, OKI', 'no blocks: one code per sample', 8, [[8, 'stream of 4-bit codes; the step size adapts as it goes', 'ok']])}
  <text class="dim" x="20" y="316" font-size="11">f|r = filter and range, p|s = predictor and scale. Orange fields are what the encoder chooses per block.</text>`));

// 3) banner
fs.writeFileSync(path.join(docs, 'banner.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 260" role="img" aria-labelledby="bt bd"><title id="bt">gamedac.js</title><desc id="bd">gamedac.js: encode and decode classic video-game audio formats in plain JavaScript: PlayStation, GameCube, ADX, Dreamcast. No WebAssembly, MIT licensed.</desc><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14202e"/><stop offset="1" stop-color="#0b0f14"/></linearGradient></defs><rect width="1000" height="260" rx="16" fill="url(#g)" stroke="#24364a"/>
<g transform="translate(48,60)"><rect width="84" height="84" rx="18" fill="#14202e" stroke="#4da3ff" stroke-width="3"/><path d="M14 46 H26 L32 22 L40 66 L48 30 L54 52 L60 46 H70" fill="none" stroke="#4da3ff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g>
<text x="160" y="104" font-family="Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="52" font-weight="800" fill="#e6ecf5">gamedac.js</text>
<text x="160" y="146" font-family="Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="24" fill="#9fb4cc">Encode and decode classic video-game audio in plain JavaScript</text>
<g font-family="Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif" font-size="18" font-weight="600" fill="#e6ecf5"><rect x="48" y="188" width="196" height="38" rx="19" fill="#1a2c1f" stroke="#4f8a5e"/><text x="146" y="213" text-anchor="middle">no WebAssembly</text><rect x="260" y="188" width="206" height="38" rx="19" fill="#14202e" stroke="#3b5a7c"/><text x="363" y="213" text-anchor="middle">21.5 KB gzipped</text><rect x="482" y="188" width="276" height="38" rx="19" fill="#14202e" stroke="#3b5a7c"/><text x="620" y="213" text-anchor="middle">VAG XA DSP ADX AICA</text><rect x="774" y="188" width="120" height="38" rx="19" fill="#14202e" stroke="#3b5a7c"/><text x="834" y="213" text-anchor="middle">MIT</text></g></svg>`);
console.log('diagrams written');