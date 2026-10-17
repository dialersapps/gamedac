// node tools/measure.mjs : regenerates docs/results.json and the measured figures. Synthetic, seeded signals only.
// Needs Node 18+. Run `node tools/build.mjs` first if gamedac.mjs changed. docs/crosscheck.json comes from tools/crosscheck-vgmstream.mjs.
import fs from 'node:fs'; import path from 'node:path'; import zlib from 'node:zlib'; import { fileURLToPath } from 'node:url'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), docs = path.join(root, 'docs');
const gd = require('../gamedac.js'), { tones, voice, snr } = require('../tests/checks.js');
fs.mkdirSync(docs, { recursive: true });
const SVG_STYLE = '<style>text{font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;fill:#e6ecf5}.dim{fill:#9fb4cc}</style>';
const SEC = 10;
const PLAN = [
  ['vag', 'VAG', {}, 44100, 1], ['xa', 'XA', {}, 37800, 2], ['dsp', 'DSP', {}, 32000, 2], ['adx', 'ADX', {}, 44100, 2],
  ['aica', 'AICA', {}, 44100, 1], ['yamaha-wav', 'Yamaha WAV', {}, 22050, 1], ['oki-wav', 'OKI WAV', { codecRate: 'native' }, 8000, 1]
];
const med = (a) => a.slice().sort((p, q) => p - q)[Math.floor(a.length / 2)];
const timeIt = (f) => { f(); const t = []; for (let i = 0; i < 3; i++) { const s = performance.now(); f(); t.push(performance.now() - s); } return Math.round(med(t)); };

const results = { generated: 'synthetic signals, seeded; Node ' + process.version, formats: [], size: {} };
for (const [id, label, o, sr, nch] of PLAN) {
  const row = { id, label, sampleRate: sr, channels: nch };
  for (const [sigName, make] of [['tones', tones], ['voice', voice]]) {
    const chans = Array.from({ length: nch }, (_, c) => make(sr, SEC, 3 + c));
    const bytes = gd.encode({ format: id, channels: chans, sampleRate: sr, ...o });
    const dec = gd.decode(bytes, gd.detect(bytes) ? {} : { format: id, sampleRate: sr, channels: nch });
    row['snr_' + sigName] = +snr(chans[0], dec.channelData[0]).toFixed(1);
    if (sigName === 'tones') {
      row.bytes = bytes.length; row.pcm16Bytes = SEC * sr * nch * 2; row.percentOfPcm16 = +(100 * bytes.length / row.pcm16Bytes).toFixed(1);
      row.bitsPerSample = +(bytes.length * 8 / (SEC * sr * nch)).toFixed(2);
      row.encodeMs = timeIt(() => gd.encode({ format: id, channels: chans, sampleRate: sr, ...o }));
      row.decodeMs = timeIt(() => gd.decode(bytes, gd.detect(bytes) ? {} : { format: id, sampleRate: sr, channels: nch }));
    }
  }
  results.formats.push(row);
}
const js = fs.readFileSync(path.join(root, 'gamedac.js'), 'utf8');
const stripped = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s+/g, ' ');
results.size = { rawBytes: Buffer.byteLength(js), strippedBytes: Buffer.byteLength(stripped), gzipBytes: zlib.gzipSync(js, { level: 9 }).length, strippedGzipBytes: zlib.gzipSync(stripped, { level: 9 }).length };
fs.writeFileSync(path.join(docs, 'results.json'), JSON.stringify(results, null, 2));

// ---------- figures ----------
const open = (W, H, title, desc, head) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d"><title id="t">${title}</title><desc id="d">${desc}</desc>${SVG_STYLE}<rect width="100%" height="100%" rx="10" fill="#0b0f14" stroke="#24364a"/><text x="20" y="26" font-size="14" font-weight="600">${head}</text>`;
const cols = { tones: '#4da3ff', voice: '#e0a95a' };
{ // SNR by format
  const W = 760, H = 380, L = 130, R = 30, T = 70, B = 40, pw = W - L - R, rowH = (H - T - B) / results.formats.length, max = 60;
  let s = open(W, H, 'Signal-to-noise ratio by format', 'Decoded signal-to-noise ratio in decibels for every format, for a tonal test signal and a voice-like test signal. Four-bit formats land between 10 and 50 dB depending on the signal.', 'Signal-to-noise ratio by format (higher is closer to the input)');
  s += `<rect x="${L}" y="40" width="14" height="4" fill="${cols.tones}"/><text x="${L + 20}" y="46" font-size="11">tonal signal</text><rect x="${L + 130}" y="40" width="14" height="4" fill="${cols.voice}"/><text x="${L + 150}" y="46" font-size="11">voice-like signal</text>`;
  for (let v = 0; v <= max; v += 10) s += `<line x1="${L + (v / max) * pw}" y1="${T}" x2="${L + (v / max) * pw}" y2="${H - B}" stroke="#1d2b3b"/><text class="dim" x="${L + (v / max) * pw}" y="${H - B + 16}" font-size="10.5" text-anchor="middle">${v} dB</text>`;
  results.formats.forEach((f, i) => { const y = T + i * rowH; s += `<text x="${L - 10}" y="${y + rowH / 2 + 4}" font-size="12.5" text-anchor="end">${f.label}</text>`; [['tones', f.snr_tones, 6], ['voice', f.snr_voice, rowH / 2 + 1]].forEach(([k, v, dy]) => { const w = Math.max(2, (Math.min(v, max) / max) * pw); s += `<rect x="${L}" y="${y + dy}" width="${w.toFixed(1)}" height="${(rowH / 2 - 5).toFixed(1)}" rx="3" fill="${cols[k]}"/><text x="${L + w + 6}" y="${y + dy + (rowH / 2 - 5) - 2}" font-size="10.5" class="dim">${v} dB</text>`; }); });
  fs.writeFileSync(path.join(docs, 'snr-by-format.svg'), s + '</svg>');
}
{ // size
  const W = 760, H = 330, L = 130, R = 40, T = 56, B = 30, pw = W - L - R, rowH = (H - T - B) / results.formats.length, max = 40;
  let s = open(W, H, 'Size as a share of 16-bit PCM', 'Every format is a fixed-rate four-bit-per-sample style codec, so files come out at about a quarter to 29 percent of the size of 16-bit PCM.', 'File size as a percentage of 16-bit PCM (lower is smaller)');
  results.formats.forEach((f, i) => { const y = T + i * rowH, w = (f.percentOfPcm16 / max) * pw; s += `<text x="${L - 10}" y="${y + rowH / 2 + 4}" font-size="12.5" text-anchor="end">${f.label}</text><rect x="${L}" y="${y + 4}" width="${w.toFixed(1)}" height="${(rowH - 10).toFixed(1)}" rx="3" fill="#4f8a5e"/><text x="${L + w + 8}" y="${y + rowH / 2 + 4}" font-size="12" font-weight="600">${f.percentOfPcm16}%  (${f.bitsPerSample} bits/sample)</text>`; });
  fs.writeFileSync(path.join(docs, 'size.svg'), s + '</svg>');
}
{ // speed (x real time), log-free linear bars for encode and decode
  const W = 760, H = 380, L = 130, R = 130, T = 70, B = 30, pw = W - L - R, rowH = (H - T - B) / results.formats.length;
  const rt = (ms) => (SEC * 1000) / ms, maxRt = Math.max(...results.formats.map((f) => rt(f.decodeMs)));
  let s = open(W, H, 'Speed as multiples of real time', 'Encoding and decoding speed for each format in multiples of real time, for 10 seconds of audio at the format\'s own rate. Decoding is much faster than encoding; DSP encoding is the slowest because it analyses the whole clip for predictors.', 'Speed: how many times faster than real time (10 s clips)');
  s += `<rect x="${L}" y="40" width="14" height="4" fill="#4da3ff"/><text x="${L + 20}" y="46" font-size="11">encode</text><rect x="${L + 90}" y="40" width="14" height="4" fill="#4f8a5e"/><text x="${L + 110}" y="46" font-size="11">decode</text>`;
  results.formats.forEach((f, i) => { const y = T + i * rowH; s += `<text x="${L - 10}" y="${y + rowH / 2 + 4}" font-size="12.5" text-anchor="end">${f.label}</text>`; [['#4da3ff', f.encodeMs, 5], ['#4f8a5e', f.decodeMs, rowH / 2 + 0]].forEach(([c, ms, dy]) => { const w = Math.max(2, (rt(ms) / maxRt) * pw); s += `<rect x="${L}" y="${y + dy}" width="${w.toFixed(1)}" height="${(rowH / 2 - 5).toFixed(1)}" rx="3" fill="${c}"/><text x="${L + w + 6}" y="${y + dy + (rowH / 2 - 5) - 2}" font-size="10.5" class="dim">${Math.round(rt(ms))}x (${ms} ms)</text>`; }); });
  fs.writeFileSync(path.join(docs, 'speed.svg'), s + `<text class="dim" x="20" y="${H - 10}" font-size="11">Node ${process.version}, one Windows PC, median of 3 runs after a warm-up.</text></svg>`);
}
{ // compatibility with vgmstream, from docs/crosscheck.json
  const cc = JSON.parse(fs.readFileSync(path.join(docs, 'crosscheck.json'), 'utf8')), byCase = new Map();
  for (const c of cc.cases) { const r = byCase.get(c.case) || { identical: 0, total: 0, opened: 0 }; r.total++; if (c.vgmstream) { /* could not open */ } else { r.opened++; if (c.identical) r.identical++; } byCase.set(c.case, r); }
  const rows = [...byCase.entries()], W = 760, rowH = 30, H = 70 + rows.length * rowH + 30;
  let s = open(W, H, 'Agreement with vgmstream', 'For each test file, whether vgmstream decodes the bytes gamedac wrote to exactly the same samples. Green rows are bit-identical for every signal tried; amber rows could not be opened by vgmstream for at least one signal.', 'Decoded by gamedac and by vgmstream: identical samples?');
  rows.forEach(([name, r], i) => { const y = 54 + i * rowH, good = r.opened === r.total && r.identical === r.total; s += `<rect x="20" y="${y}" width="720" height="${rowH - 6}" rx="6" fill="${good ? '#1a2c1f' : '#2a2216'}" stroke="${good ? '#4f8a5e' : '#a67c2e'}"/><text x="34" y="${y + 17}" font-size="12.5" font-weight="600">${name}</text><text class="dim" x="726" y="${y + 17}" font-size="11.5" text-anchor="end">${good ? 'bit-identical (' + r.identical + ' of ' + r.total + ' signals)' : r.opened === 0 ? 'vgmstream cannot open this file' : r.identical + ' of ' + r.total + ' signals identical; ' + (r.total - r.opened) + ' not opened'}</text>`; });
  fs.writeFileSync(path.join(docs, 'compat.svg'), s + '</svg>');
}
console.log(JSON.stringify({ size: results.size, formats: results.formats.map((f) => [f.id, f.percentOfPcm16, f.snr_tones, f.snr_voice, f.encodeMs, f.decodeMs].join(' ')) }, null, 1));