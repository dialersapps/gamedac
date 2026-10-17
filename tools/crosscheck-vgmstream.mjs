// node tools/crosscheck-vgmstream.mjs <path-to-vgmstream-wasm/index.mjs>
// Optional independent check: encodes with gamedac, then decodes the same bytes with gamedac and with vgmstream (compiled to
// WebAssembly; any build exposing vgmDecode(bytes, filename, { loops: 0 }) -> { samples } works) and compares the results.
// Writes docs/crosscheck.json. Not part of `npm test` because it needs a vgmstream build, which this repository does not ship.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gd = require('../gamedac.js'), { voice, tones } = require('../tests/checks.js');
const idx = process.argv[2] || process.env.VGMSTREAM_INDEX;
if (!idx) { console.error('usage: node tools/crosscheck-vgmstream.mjs <path to vgmstream index.mjs>'); process.exit(2); }
const { vgmDecode } = await import(pathToFileURL(path.resolve(idx)).href);
const snr = (a, b) => { let s = 0, e = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) { s += a[i] * a[i]; e += (a[i] - b[i]) ** 2; } return e === 0 ? Infinity : 10 * Math.log10(s / e); };
const maxLsb = (a, b) => { let m = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]) * 32768); return m; };
const toPeak = (x, peak) => { let m = 0; for (const v of x) m = Math.max(m, Math.abs(v)); const g = peak / m; return x.map((v) => v * g); };
// [label, format, options, sampleRate, channels, filename vgmstream needs]
const CASES = [
  ['vag mono 44.1k', 'vag', {}, 44100, 1, 'a.vag'], ['vag mono 22.05k', 'vag', {}, 22050, 1, 'a.vag'], ['vag stereo (VAGi)', 'vag', { interleave: true }, 44100, 2, 'a.vag'],
  ['xa stereo 37.8k', 'xa', {}, 37800, 2, 'a.xa'], ['xa mono 18.9k', 'xa', { xaRate: 18900 }, 18900, 1, 'a.xa'],
  ['dsp mono 32k', 'dsp', {}, 32000, 1, 'a.dsp'], ['dsp stereo 32k', 'dsp', {}, 32000, 2, 'a.dsp'], ['adx stereo 44.1k', 'adx', {}, 44100, 2, 'a.adx'], ['adx mono 22.05k', 'adx', {}, 22050, 1, 'a.adx'],
  ['aica (Yamaha WAV, AICA variant) 22.05k', 'yamaha-wav', { variant: 'aica' }, 22050, 1, 'a.wav'], ['oki-wav 8k', 'oki-wav', { codecRate: 'native' }, 8000, 1, 'a.wav'],
  // headerless formats: vgmstream needs a TXTH companion that names the codec (the 8th field)
  ['vb raw 22.05k (via TXTH)', 'vb', {}, 22050, 1, 'a.vb', 'PSX', 'data_size*28/16'], ['aica raw 44.1k (via TXTH)', 'aica', {}, 44100, 1, 'a.aica', 'AICA', 'data_size*2'], ['oki vox 8k vs vgmstream OKI4S (via TXTH)', 'vox', { codecRate: 'native' }, 8000, 1, 'a.vox', 'OKI4S', 'data_size*2']
];
const out = { tool: 'vgmstream compiled to WebAssembly (path given on the command line)', note: 'snrOursVsVgmstreamDb is Infinity (written as null) when the two decoders produced identical samples', cases: [] };
for (const [label, fmt, o, sr, nch, fname, txthCodec, txthSamples] of CASES) {
  for (const [sigName, make] of [['voice-like, peak 0.8', (s, seed) => toPeak(voice(s, 3, seed), 0.8)], ['tones', (s, seed) => tones(s, 3, seed)]]) {
    const chans = Array.from({ length: nch }, (_, c) => make(sr, 3 + c));
    const bytes = gd.encode({ format: fmt, channels: chans, sampleRate: sr, ...o });
    const ours = gd.decode(bytes, { format: gd.detect(bytes) ? undefined : fmt, sampleRate: sr, channels: nch, ...(o.variant ? { variant: o.variant } : {}), ...(o.interleave ? { interleave: 16 } : {}) });
    const row = { case: label, signal: sigName, bytes: bytes.length };
    try {
      const companions = txthCodec ? { [fname + '.txth']: new TextEncoder().encode('codec = ' + txthCodec + '\nsample_rate = ' + sr + '\nchannels = ' + nch + '\nstart_offset = 0\nnum_samples = ' + txthSamples + '\n') } : undefined;
      const r = await vgmDecode(bytes, fname, { loops: 0, companions });
      const same = r.samples[0].length === ours.channelData[0].length;
      const s1 = snr(ours.channelData[0], r.samples[0]);
      Object.assign(row, { vgmstreamCodec: r.codec, vgmstreamChannels: r.channels, sameLength: same, maxDiffLsb: +maxLsb(ours.channelData[0], r.samples[0]).toFixed(2), snrOursVsVgmstreamDb: Number.isFinite(s1) ? +s1.toFixed(1) : null, identical: s1 === Infinity });
      if (r.channels > 1 && ours.channelData[1]) { const s2 = snr(ours.channelData[1], r.samples[1]); row.maxDiffLsbCh1 = +maxLsb(ours.channelData[1], r.samples[1]).toFixed(2); row.identicalCh1 = s2 === Infinity; }
    } catch (e) { row.vgmstream = 'could not open: ' + String(e.message).split(':').slice(-1)[0].trim().slice(0, 80); }
    out.cases.push(row);
    console.log(label.padEnd(42), sigName.padEnd(22), row.vgmstream || ('vgm ' + row.vgmstreamCodec + ' | maxdiff ' + row.maxDiffLsb + ' LSB | ' + (row.identical ? 'IDENTICAL' : row.snrOursVsVgmstreamDb + ' dB')));
  }
}
fs.writeFileSync(path.join(root, 'docs', 'crosscheck.json'), JSON.stringify(out, null, 2));