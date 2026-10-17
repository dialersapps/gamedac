/*!
 * gamedac.js 1.0.0 - encode and decode classic video-game audio formats in plain JavaScript.
 *
 * PlayStation VAG / VB / XA, Nintendo GameCube-Wii DSP, CRI ADX, Yamaha AICA (Dreamcast) ADPCM and OKI/Dialogic
 * ADPCM, each with an encoder and a decoder. No WebAssembly, no dependencies, no DOM: it runs in a page, in a Web
 * Worker or in Node.
 *
 * Copyright (c) 2026 Dialer's Apps
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
 * following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial
 * portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
 * LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
 * EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
 * USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Written from public format documentation (the nocash PSX-SPX notes, the GameCube DSP header layout, the
 * published descriptions of ADX, Yamaha and OKI ADPCM); the code is not derived from vgmstream, VGAudio,
 * FFmpeg or any other encoder or decoder.
 *
 * API:
 *   gamedac.decode(bytes, { format? })        -> { format, sampleRate, channels, channelData: Float32Array[], loop?, ... }
 *   gamedac.encode({ format, channels, sampleRate, ... }) -> Uint8Array   (format: vag, vb, xa, dsp, adx, aica, yamaha-wav, vox, oki-wav)
 *   gamedac.detect(bytes)                     -> format id or null (headerless formats cannot be detected)
 *   gamedac.toWav(decoded)                    -> Uint8Array, a plain 16-bit PCM WAV
 *   gamedac.formats                           -> list of the formats and their extensions
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.gamedac = factory();
}(typeof self !== 'undefined' ? self : this, function () {
'use strict';
const wavutil = (() => {
/**
 * Small shared helpers for the telephony ADPCM codecs (oki-adpcm, yamaha-adpcm,
 * g726, g722): windowed-sinc resampler, channel remixing, float<->int16 and a
 * minimal non-PCM WAV writer/parser.
 */

/** Resample one channel with a Blackman-windowed sinc (low-pass when downsampling). */
function resampleChannel(input, fromRate, toRate, opts = {}) {
  if (!input.length || fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const fc = Math.min(1, ratio);
  const W = opts.zeroCrossings || 12;
  const half = W / fc;
  const RES = 512;
  const tab = new Float64Array(W * RES + 2);
  for (let k = 0; k < tab.length; k++) {
    const u = k / RES;
    const sinc = u === 0 ? 1 : Math.sin(Math.PI * u) / (Math.PI * u);
    const x = Math.min(1, u / W);
    const win = 0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);
    tab[k] = sinc * win;
  }
  const n = input.length;
  const step = 1 / ratio;
  for (let j = 0; j < outLen; j++) {
    const t = j * step;
    let i0 = Math.ceil(t - half);
    let i1 = Math.floor(t + half);
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    let sum = 0;
    let wsum = 0;
    for (let i = i0; i <= i1; i++) {
      const idx = Math.abs((i - t) * fc) * RES;
      const k = idx | 0;
      const g = tab[k] + (tab[k + 1] - tab[k]) * (idx - k);
      sum += g * input[i];
      wsum += g;
    }
    out[j] = wsum !== 0 ? sum / wsum : 0;
  }
  return out;
}

function resampleChannels(arrays, fromRate, toRate, opts) {
  return arrays.map((a) => resampleChannel(a, fromRate, toRate, opts));
}

/** Convert a list of channel arrays to exactly `n` channels (average to mono, truncate, or duplicate). */
function remixChannels(arrays, n) {
  if (arrays.length === n) return arrays;
  if (n === 1) {
    const len = arrays[0].length;
    const out = new Float32Array(len);
    for (const a of arrays) for (let i = 0; i < len; i++) out[i] += a[i] || 0;
    for (let i = 0; i < len; i++) out[i] /= arrays.length;
    return [out];
  }
  const out = [];
  for (let c = 0; c < n; c++) out.push(arrays[Math.min(c, arrays.length - 1)]);
  return out;
}

/** Concatenate chunk lists collected by encode(): chunks[c] = array of Float32Array. */
function concatChannelChunks(chunks, nch) {
  const out = [];
  for (let c = 0; c < nch; c++) {
    const list = chunks[c] || [];
    let len = 0;
    for (const a of list) len += a.length;
    const arr = new Float32Array(len);
    let o = 0;
    for (const a of list) { arr.set(a, o); o += a.length; }
    out.push(arr);
  }
  return out;
}

function floatToInt16(s) {
  if (!(s > -1)) return s < -1 || s === -Infinity ? -32768 : 0;
  if (s > 1) return 32767;
  return Math.round(s < 0 ? s * 32768 : s * 32767);
}

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function readAscii(bytes, offset, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i]);
  return s;
}

/**
 * Build a RIFF/WAVE file with an 18-byte fmt chunk (cbSize = extra.length),
 * a fact chunk and the data chunk.
 */
function buildWav({ formatTag, channels, sampleRate, byteRate, blockAlign, bitsPerSample, extra, frames, data }) {
  const ex = extra || new Uint8Array(0);
  const fmtSize = 18 + ex.length;
  const dataPad = data.length & 1;
  const total = 12 + 8 + fmtSize + (fmtSize & 1) + 12 + 8 + data.length + dataPad;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let o = 0;
  writeAscii(v, o, 'RIFF'); v.setUint32(o + 4, total - 8, true); writeAscii(v, o + 8, 'WAVE'); o += 12;
  writeAscii(v, o, 'fmt '); v.setUint32(o + 4, fmtSize, true); o += 8;
  v.setUint16(o, formatTag, true);
  v.setUint16(o + 2, channels, true);
  v.setUint32(o + 4, sampleRate, true);
  v.setUint32(o + 8, byteRate, true);
  v.setUint16(o + 12, blockAlign, true);
  v.setUint16(o + 14, bitsPerSample, true);
  v.setUint16(o + 16, ex.length, true);
  out.set(ex, o + 18);
  o += fmtSize + (fmtSize & 1);
  writeAscii(v, o, 'fact'); v.setUint32(o + 4, 4, true); v.setUint32(o + 8, frames, true); o += 12;
  writeAscii(v, o, 'data'); v.setUint32(o + 4, data.length, true); o += 8;
  out.set(data, o);
  return out;
}

function isWav(bytes) {
  return bytes.length >= 12 && readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WAVE';
}

/** Format tag of a WAV file or -1. */
function wavFormatTag(bytes) {
  if (!isWav(bytes)) return -1;
  try {
    return parseWav(bytes).formatTag;
  } catch {
    return -1;
  }
}

function parseWav(bytes) {
  if (!isWav(bytes)) throw new Error('Invalid WAV file.');
  let fmt = null;
  let data = null;
  let fact = -1;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = (bytes[offset + 4] | (bytes[offset + 5] << 8) | (bytes[offset + 6] << 16) | (bytes[offset + 7] << 24)) >>> 0;
    const start = offset + 8;
    const end = Math.min(bytes.length, start + size);
    if (id === 'fmt ' && !fmt) fmt = bytes.subarray(start, end);
    else if (id === 'data' && !data) data = bytes.subarray(start, end);
    else if (id === 'fact' && size >= 4) {
      fact = (bytes[start] | (bytes[start + 1] << 8) | (bytes[start + 2] << 16) | (bytes[start + 3] << 24)) >>> 0;
    }
    offset = start + size + (size & 1);
  }
  if (!fmt || fmt.length < 16 || !data) throw new Error('WAV missing fmt or data chunk.');
  const v = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  return {
    formatTag: v.getUint16(0, true),
    channels: v.getUint16(2, true),
    sampleRate: v.getUint32(4, true),
    byteRate: v.getUint32(8, true),
    blockAlign: v.getUint16(12, true),
    bitsPerSample: v.getUint16(14, true),
    extra: fmt.length >= 18 ? fmt.subarray(18, 18 + v.getUint16(16, true)) : new Uint8Array(0),
    factSamples: fact,
    data
  };
}

return { resampleChannel, resampleChannels, remixChannels, concatChannelChunks, floatToInt16, buildWav, isWav, parseWav, wavFormatTag };
})();

const psxVag = (() => {
/**
 * Sony PlayStation SPU-ADPCM ("VAG") encode and decode.
 *
 *  - .vag  : 48-byte "VAGp" big-endian header + 16-byte SPU-ADPCM blocks (mono)
 *  - .vagi : "VAGi" header (interleave at 0x08 LE, channels at 0x1E, per-channel size at 0x0C), data from 0x800, interleaved in chunks
 *  - .vb   : headerless stream of 16-byte blocks
 *
 * Block: byte0 = (filter << 4) | shift-range, byte1 = flags, bytes 2..15 = 28 4-bit samples
 * (low nibble first). Flags: bit0 loop end, bit1 loop repeat, bit2 loop start.
 * Filters (x/64): (0,0) (60,0) (115,-52) (98,-55) (122,-60).
 */

const F0 = [0, 60, 115, 98, 122];
const F1 = [0, 0, -52, -55, -60];

const VAG_INFO = {
  id: 'psx-vag',
  label: 'PlayStation VAG (SPU-ADPCM)',
  extensions: ['vag', 'vagi'],
  mime: 'audio/x-vag',
  sniff(bytes) {
    return !!bytes && bytes.length >= 48 && bytes[0] === 0x56 && bytes[1] === 0x41 &&
      bytes[2] === 0x47 && (bytes[3] === 0x70 || bytes[3] === 0x69);
  }
};

const VB_INFO = {
  id: 'psx-vb',
  label: 'PlayStation VB (raw SPU-ADPCM)',
  extensions: ['vb'],
  mime: 'audio/x-vb',
  sniff() { return false; } // headerless: cannot be detected by content
};

function clamp16(v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
// Prediction uses the arithmetic shift (x >> 6) with the running state kept unclamped and only the output clamped to 16 bits;
// this is bit-exact with vgmstream's PS-ADPCM decoder (the nocash PSX-SPX notes add +32 for rounding, a difference of under 1 LSB per sample).
function predict(o1, o2, f) { return (o1 * F0[f] + o2 * F1[f]) >> 6; }

function readU32BE(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function readU32LE(b, o) { return ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0; }
function writeU32BE(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
function writeU32LE(b, o, v) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }

/** Decode one 16-byte block at `off` into out[outPos..+28]; state = {o1,o2}. */
function decodeBlock(b, off, out, outPos, st) {
  let range = b[off] & 15;
  let filter = b[off] >> 4;
  if (filter > 4) filter = 4;
  if (range > 12) range = 9; // hardware quirk (nocash PSX-SPX)
  const shift = 12 - range;
  let o1 = st.o1, o2 = st.o2;
  for (let i = 0; i < 28; i++) {
    const byte = b[off + 2 + (i >> 1)];
    let n = (i & 1) ? byte >> 4 : byte & 15;
    if (n >= 8) n -= 16;
    const raw = (n << shift) + predict(o1, o2, filter);
    o2 = o1; o1 = raw;
    out[outPos + i] = clamp16(raw) / 32768;
  }
  st.o1 = o1; st.o2 = o2;
}

function isDummyBlock(b, off) {
  if (b[off] !== 0 || b[off + 1] !== 7) return false;
  for (let i = 2; i < 16; i++) if (b[off + i] !== 0x77) return false;
  return true;
}

/** Decode a single channel's block stream. stopAtEnd: stop after a block with the end flag. */
function decodeStream(b, start, end, stopAtEnd) {
  const nBlocks = Math.floor((end - start) / 16);
  const out = new Float32Array(nBlocks * 28);
  const st = { o1: 0, o2: 0 };
  let n = 0;
  let loopStart = -1, loopEnd = -1;
  for (let k = 0; k < nBlocks; k++) {
    const off = start + k * 16;
    const flag = b[off + 1];
    if (stopAtEnd && isDummyBlock(b, off)) break;
    if (flag & 4 && loopStart < 0) loopStart = k * 28;
    decodeBlock(b, off, out, n, st);
    n += 28;
    if (stopAtEnd && (flag & 1)) {
      if (flag & 2) loopEnd = n;
      break;
    }
  }
  const loop = loopStart >= 0 || loopEnd >= 0
    ? { start: Math.max(0, loopStart), end: loopEnd >= 0 ? loopEnd : n }
    : null;
  return { data: out.subarray(0, n), loop };
}

function splitInterleaved(b, start, end, channels, interleave) {
  const parts = Array.from({ length: channels }, () => []);
  const chunk = interleave * channels;
  for (let p = start, i = 0; p < end; p += interleave, i++) {
    const ch = i % channels;
    const e = Math.min(end, p + interleave);
    parts[ch].push([p, e - ((e - p) % 16)]);
  }
  void chunk;
  return parts;
}

function decodeChannels(b, start, end, channels, interleave, stopAtEnd) {
  if (channels <= 1) {
    const r = decodeStream(b, start, end, stopAtEnd);
    return { channelData: [r.data], loop: r.loop };
  }
  if (!interleave || interleave % 16) throw new Error('Invalid VAG interleave size.');
  const parts = splitInterleaved(b, start, end, channels, interleave);
  const channelData = [];
  let loop = null;
  for (let ch = 0; ch < channels; ch++) {
    // gather the channel's bytes contiguously, then decode as one stream
    let total = 0;
    for (const [s, e] of parts[ch]) total += e - s;
    const buf = new Uint8Array(total);
    let o = 0;
    for (const [s, e] of parts[ch]) { buf.set(b.subarray(s, e), o); o += e - s; }
    const r = decodeStream(buf, 0, total, stopAtEnd);
    channelData.push(r.data);
    if (!loop) loop = r.loop;
  }
  const len = Math.min(...channelData.map((c) => c.length));
  return { channelData: channelData.map((c) => c.subarray(0, len)), loop };
}

/**
 * Decode a .vag / .vagi file (VAGp / VAGi header). Headerless data is treated as a raw stream.
 * opts: { sampleRate, channels, interleave } (override / headerless defaults).
 */
function decodeVag(bytes, opts = {}) {
  if (!bytes || bytes.length < 16) throw new Error('Invalid VAG file.');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== 'VAGp' && magic !== 'VAGi') {
    if (opts.allowHeaderless) return decodeVb(bytes, opts);
    throw new Error('Invalid VAG file (missing VAGp/VAGi header).');
  }
  // VAGp: 48-byte header. VAGi (interleaved): the audio starts at 0x800, as vgmstream expects.
  const start = magic === 'VAGi' && bytes.length >= 0x800 + 16 ? 0x800 : 48;
  if (bytes.length < start + 16) throw new Error('VAG file too short.');
  const size = readU32BE(bytes, 12);
  let sampleRate = readU32BE(bytes, 16);
  if (!sampleRate || sampleRate > 1000000) sampleRate = 44100;
  if (opts.sampleRate) sampleRate = opts.sampleRate;
  let channels = opts.channels || 1;
  let interleave = opts.interleave || 0;
  if (magic === 'VAGi') {
    if (!interleave) interleave = readU32LE(bytes, 8);
    if (!opts.channels) channels = bytes[0x1e] >= 1 && bytes[0x1e] <= 16 ? bytes[0x1e] : 2;
  }
  if (typeof interleave !== 'number') interleave = 0;
  let end = bytes.length;
  // In a VAGi file the size field counts one channel's data (vgmstream refuses the file otherwise).
  const dataSize = magic === 'VAGi' ? size * channels : size;
  if (dataSize > 0 && start + dataSize <= bytes.length) end = start + dataSize;
  end = start + Math.floor((end - start) / 16) * 16;
  if (channels > 1 && !interleave) interleave = 16;
  const { channelData, loop } = decodeChannels(bytes, start, end, channels, interleave, true);
  const name = String.fromCharCode(...Array.from(bytes.subarray(32, 48)).filter((c) => c >= 32 && c < 127)).trim();
  return { sampleRate, channels, channelData, loop, name };
}

/** Decode a raw headerless .vb stream. opts: { sampleRate=44100, channels=1, interleave=16 }. */
function decodeVb(bytes, opts = {}) {
  if (!bytes || bytes.length < 16) throw new Error('Invalid VB data.');
  const channels = opts.channels || 1;
  const sampleRate = opts.sampleRate || 44100;
  const end = Math.floor(bytes.length / 16) * 16;
  const { channelData } = decodeChannels(bytes, 0, end, channels, opts.interleave || 16, false);
  return { sampleRate, channels, channelData, loop: null, name: '' };
}

// ---------------------------------------------------------------- encoder

/**
 * Closed-loop search over filters/ranges for one 28-sample block.
 * x: Float64Array(28) in int16 scale. st: {o1,o2}. Updates st. Returns { filter, range, codes }.
 */
function encodeBlockSearch(x, st, nFilters) {
  let best = null;
  let bestErr = Infinity;
  const codes = new Int8Array(28);
  for (let f = 0; f < nFilters; f++) {
    for (let r = 0; r <= 12; r++) {
      const shift = 12 - r;
      const scale = 1 << shift;
      let o1 = st.o1, o2 = st.o2, err = 0;
      for (let i = 0; i < 28; i++) {
        const p = predict(o1, o2, f);
        let t = Math.round((x[i] - p) / scale);
        if (t > 7) t = 7; else if (t < -8) t = -8;
        const raw = (t << shift) + p;
        const e = x[i] - clamp16(raw);
        err += e * e;
        codes[i] = t;
        o2 = o1; o1 = raw;
        if (err >= bestErr) break;
      }
      if (err < bestErr) {
        bestErr = err;
        best = { filter: f, range: r, codes: Int8Array.from(codes), o1, o2 };
      }
    }
  }
  st.o1 = best.o1; st.o2 = best.o2;
  return best;
}

function encodeChannelBlocks(samples, loopInfo) {
  const nBlocks = Math.max(1, Math.ceil(samples.length / 28));
  let last = nBlocks - 1;
  let loopStartBlock = -1;
  if (loopInfo) {
    loopStartBlock = Math.min(nBlocks - 1, Math.floor(loopInfo.start / 28));
    last = Math.min(nBlocks - 1, Math.max(loopStartBlock, Math.ceil(loopInfo.end / 28) - 1));
  }
  const out = new Uint8Array((last + 1) * 16);
  const st = { o1: 0, o2: 0 };
  const x = new Float64Array(28);
  for (let k = 0; k <= last; k++) {
    for (let i = 0; i < 28; i++) {
      const v = samples[k * 28 + i];
      x[i] = v === undefined ? 0 : clamp16(Math.round(v * 32768));
    }
    const b = encodeBlockSearch(x, st, 5);
    const off = k * 16;
    out[off] = (b.filter << 4) | b.range;
    let flag = 0;
    if (loopInfo) {
      if (k === loopStartBlock) flag |= 4;
      if (k === last) flag |= 3;
    } else if (k === last) {
      flag = 1;
    }
    out[off + 1] = flag;
    for (let i = 0; i < 14; i++) out[off + 2 + i] = (b.codes[2 * i] & 15) | ((b.codes[2 * i + 1] & 15) << 4);
  }
  return out;
}

/**
 * opts: { sampleRate=44100, format: 'vag'|'vagi'|'vb', interleave: boolean (=> vagi),
 *         interleaveSize=16, loop: true | {start,end} (sample indices), name }
 * Multi-channel input is downmixed to mono unless interleave / format 'vagi' is requested.
 */
function createPsxVag(opts = {}) {
  const sampleRate = opts.sampleRate || 44100;
  const format = opts.format || (opts.interleave ? 'vagi' : 'vag');
  const interleaveSize = Math.max(16, Math.round((opts.interleaveSize || 16) / 16) * 16);
  let chunks = [];
  let nch = 0;

  return {
    encode(channelArrays) {
      if (!nch) { nch = channelArrays.length; chunks = Array.from({ length: nch }, () => []); }
      for (let c = 0; c < nch; c++) chunks[c].push(Float32Array.from(channelArrays[c] || []));
      return new Uint8Array(0);
    },
    flush() {
      const channels = nch || 1;
      let data = chunks.map((list) => {
        const len = list.reduce((a, c) => a + c.length, 0);
        const all = new Float32Array(len);
        let o = 0;
        for (const c of list) { all.set(c, o); o += c.length; }
        return all;
      });
      if (!data.length) data = [new Float32Array(0)];
      const interleaved = format === 'vagi' || (format === 'vb' && opts.interleave);
      if (!interleaved && data.length > 1) {
        const mono = new Float32Array(data[0].length);
        for (let i = 0; i < mono.length; i++) {
          let s = 0;
          for (const d of data) s += d[i] || 0;
          mono[i] = s / data.length;
        }
        data = [mono];
      }
      let loopInfo = null;
      if (opts.loop) {
        loopInfo = opts.loop === true ? { start: 0, end: data[0].length } :
          { start: opts.loop.start | 0, end: opts.loop.end > 0 ? opts.loop.end | 0 : data[0].length };
      }
      const streams = data.map((d) => encodeChannelBlocks(d, loopInfo));
      let body;
      if (streams.length === 1) {
        body = streams[0];
      } else {
        const per = Math.ceil(Math.max(...streams.map((s) => s.length)) / interleaveSize) * interleaveSize;
        body = new Uint8Array(per * streams.length);
        for (let c = 0; c < streams.length; c++) {
          for (let p = 0; p < per; p += interleaveSize) {
            const slice = streams[c].subarray(p, Math.min(streams[c].length, p + interleaveSize));
            body.set(slice, (p / interleaveSize) * interleaveSize * streams.length + c * interleaveSize);
          }
        }
      }
      let out;
      if (format === 'vb') {
        out = body;
      } else {
        const multi = streams.length > 1, hdr = multi ? 0x800 : 48;
        out = new Uint8Array(hdr + body.length);
        out.set([0x56, 0x41, 0x47, multi ? 0x69 : 0x70], 0);
        writeU32BE(out, 4, 0x20);
        if (multi) { writeU32LE(out, 8, interleaveSize); out[0x1e] = streams.length; }
        writeU32BE(out, 12, multi ? body.length / streams.length : body.length);
        writeU32BE(out, 16, sampleRate);
        const name = String(opts.name || 'gamedac').slice(0, 16);
        for (let i = 0; i < name.length; i++) out[32 + i] = name.charCodeAt(i) & 127;
        out.set(body, hdr);
      }
      chunks = []; nch = 0;
      void channels;
      return out;
    },
    free() { chunks = []; nch = 0; }
  };
}

return { decodeVag, decodeVb, create: createPsxVag, VAG_INFO, VB_INFO };
})();

const psxXa = (() => {
/**
 * Sony PlayStation CD-ROM XA ADPCM (.xa) decode and encode.
 *
 * Raw sector (2352 bytes): 12 sync, 4 header (BCD M S F + mode 2), 8 subheader
 * (file, channel, submode, coding; duplicated), 2324 data = 18 sound groups x 128 bytes,
 * then 4 bytes EDC. Sound group = 16 bytes parameters + 112 bytes data (28 words).
 * Filters (x/64): (0,0) (60,0) (115,-52) (98,-55).
 */

const F0 = [0, 60, 115, 98];
const F1 = [0, 0, -52, -55];
const SYNC = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];
const SECTOR = 2352;
const SECTOR_NOSYNC = 2336;
const DATA_BYTES = 2324;
const GROUPS = 18;

const XA_RATES = Object.freeze([37800, 18900]);

const XA_INFO = {
  id: 'psx-xa',
  label: 'PlayStation CD-ROM XA ADPCM',
  extensions: ['xa'],
  mime: 'audio/x-xa',
  sniff(bytes) {
    if (!bytes || bytes.length < 24) return false;
    let isSync = true;
    for (let i = 0; i < 12; i++) if (bytes[i] !== SYNC[i]) { isSync = false; break; }
    if (isSync) return bytes[15] === 2 && (bytes[18] & 4) !== 0 && bytes[16] === bytes[20] && bytes[18] === bytes[22];
    // 2336-byte sectors: subheader first
    return bytes.length % SECTOR_NOSYNC === 0 && bytes[0] === bytes[4] && bytes[1] === bytes[5] &&
      bytes[2] === bytes[6] && bytes[3] === bytes[7] && (bytes[2] & 4) !== 0 && (bytes[2] & 0x20) !== 0 &&
      (bytes[3] & 0xc8) === 0;
  }
};

function clamp16(v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }
// Prediction is (x + 32) >> 6 as in the nocash PSX-SPX notes; bit-exact with vgmstream's CD-ROM XA decoder.
function predict(o1, o2, f) { return (o1 * F0[f] + o2 * F1[f] + 32) >> 6; }

// ---------------------------------------------------------------- EDC

const EDC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let e = i;
    for (let j = 0; j < 8; j++) e = (e >>> 1) ^ ((e & 1) ? 0xd8018001 : 0);
    t[i] = e >>> 0;
  }
  return t;
})();

/** CD-ROM EDC (CRC-32 variant, poly 0xD8018001 reflected, init 0) over bytes[start,end). */
function xaEdc(bytes, start, end) {
  let crc = 0;
  for (let i = start; i < end; i++) crc = ((crc >>> 8) ^ EDC_TABLE[(crc ^ bytes[i]) & 255]) >>> 0;
  return crc >>> 0;
}

// ---------------------------------------------------------------- decoder

/** Decode one 128-byte sound group at d[g..]. mode: bits 4|8, stereo bool. */
function decodeGroup(d, g, bits8, stereo, st, outs, pos) {
  const units = bits8 ? 4 : 8;
  const counts = [0, 0];
  for (let u = 0; u < units; u++) {
    const pb = d[g + (u < 4 ? u : 8 + (u - 4))];
    let range = pb & 15;
    const filter = (pb >> 4) & 3;
    const maxShift = bits8 ? 8 : 12;
    if (range > 12) range = 9;
    const shift = Math.max(0, maxShift - range);
    const ch = stereo ? (u & 1) : 0;
    const s = st[ch];
    let o1 = s.o1, o2 = s.o2;
    const out = outs[ch];
    let p = pos[ch];
    for (let w = 0; w < 28; w++) {
      let n;
      if (bits8) {
        n = d[g + 16 + w * 4 + u];
        if (n >= 128) n -= 256;
      } else {
        const byte = d[g + 16 + w * 4 + (u >> 1)];
        n = (u & 1) ? byte >> 4 : byte & 15;
        if (n >= 8) n -= 16;
      }
      const v = clamp16((n << shift) + predict(o1, o2, filter));
      o2 = o1; o1 = v;
      out[p++] = v / 32768;
    }
    s.o1 = o1; s.o2 = o2;
    pos[ch] = p;
    counts[ch] += 28;
  }
}

/**
 * Decode an XA file. opts: { file, channel } select an interleaved stream (default: first audio
 * sector found); { codingInfo } is required only for headerless 2324-byte sector data.
 * Accepts 2352-byte raw sectors, 2336-byte sectors (no sync/header) and 2324-byte data.
 * Returns { sampleRate, channels, channelData, bits, file, channel, streams }.
 */
function decodeXa(bytes, opts = {}) {
  if (!bytes || bytes.length < 2324) throw new Error('Invalid XA file.');
  let secSize, subOff, dataOff;
  let hasSync = true;
  for (let i = 0; i < 12; i++) if (bytes[i] !== SYNC[i]) { hasSync = false; break; }
  if (hasSync) { secSize = SECTOR; subOff = 16; dataOff = 24; }
  else if (bytes.length % SECTOR_NOSYNC === 0) { secSize = SECTOR_NOSYNC; subOff = 0; dataOff = 8; }
  else if (opts.codingInfo != null && bytes.length % DATA_BYTES === 0) { secSize = DATA_BYTES; subOff = -1; dataOff = 0; }
  else throw new Error('Unrecognised XA sector layout.');
  const nSec = Math.floor(bytes.length / secSize);

  // pass 1: list audio streams and pick one
  const streams = new Map();
  let sel = null;
  const picked = [];
  for (let s = 0; s < nSec; s++) {
    const base = s * secSize;
    let file = 0, chn = 0, coding;
    if (subOff >= 0) {
      const o = base + subOff;
      const sub = bytes[o + 2];
      if (!(sub & 4)) continue; // not audio
      if (sub & 2 || sub & 8) continue; // video / data
      file = bytes[o]; chn = bytes[o + 1]; coding = bytes[o + 3];
    } else {
      coding = opts.codingInfo;
    }
    const key = `${file}:${chn}`;
    streams.set(key, (streams.get(key) || 0) + 1);
    if (!sel) {
      if (opts.file != null && opts.file !== file) continue;
      if (opts.channel != null && opts.channel !== chn) continue;
      sel = { file, channel: chn, coding };
    }
    if (sel && sel.file === file && sel.channel === chn && coding === sel.coding) picked.push(base + dataOff);
  }
  if (!sel) throw new Error('No matching XA audio sectors found.');

  const stereo = (sel.coding & 3) === 1;
  const bits8 = ((sel.coding >> 4) & 3) === 1;
  const sampleRate = ((sel.coding >> 2) & 3) === 1 ? 18900 : 37800;
  const channels = stereo ? 2 : 1;
  const perSector = (bits8 ? 4 : 8) * 28 * GROUPS / channels;
  const outs = Array.from({ length: channels }, () => new Float32Array(picked.length * perSector));
  const pos = [0, 0];
  const st = [{ o1: 0, o2: 0 }, { o1: 0, o2: 0 }];
  for (const off of picked) {
    for (let g = 0; g < GROUPS; g++) decodeGroup(bytes, off + g * 128, bits8, stereo, st, outs, pos);
  }
  return {
    sampleRate, channels, channelData: outs, bits: bits8 ? 8 : 4,
    file: sel.file, channel: sel.channel,
    streams: Array.from(streams, ([k, n]) => { const [f, c] = k.split(':'); return { file: +f, channel: +c, sectors: n }; })
  };
}

// ---------------------------------------------------------------- encoder

function encodeUnitSearch(x, st, bits8) {
  const maxRange = bits8 ? 8 : 12;
  const base = bits8 ? 8 : 12;
  const qmin = bits8 ? -128 : -8;
  const qmax = bits8 ? 127 : 7;
  let best = null;
  let bestErr = Infinity;
  const codes = new Int16Array(28);
  for (let f = 0; f < 4; f++) {
    for (let r = 0; r <= maxRange; r++) {
      const shift = base - r;
      const scale = 1 << shift;
      let o1 = st.o1, o2 = st.o2, err = 0;
      for (let i = 0; i < 28; i++) {
        const p = predict(o1, o2, f);
        let t = Math.round((x[i] - p) / scale);
        if (t > qmax) t = qmax; else if (t < qmin) t = qmin;
        const s = clamp16((t << shift) + p);
        const e = x[i] - s;
        err += e * e;
        codes[i] = t;
        o2 = o1; o1 = s;
        if (err >= bestErr) break;
      }
      if (err < bestErr) { bestErr = err; best = { filter: f, range: r, codes: Int16Array.from(codes), o1, o2 }; }
    }
  }
  st.o1 = best.o1; st.o2 = best.o2;
  return best;
}

function resampleLinear(src, from, to) {
  if (from === to) return src;
  const n = Math.max(0, Math.round(src.length * to / from));
  const out = new Float32Array(n);
  const ratio = from / to;
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const fr = p - i0;
    const a = src[Math.min(i0, src.length - 1)] || 0;
    const b = src[Math.min(i0 + 1, src.length - 1)] || 0;
    out[i] = a + (b - a) * fr;
  }
  return out;
}

/** Target XA rate for opts: opts.xaRate (37800|18900) or opts.level ('A' | 'B' | 'C'); default 37800. */
function xaTargetRate(opts = {}) {
  if (opts.xaRate === 18900 || opts.xaRate === 37800) return opts.xaRate;
  const lvl = String(opts.level || '').toUpperCase();
  if (lvl === 'B' || lvl === 'C') return 18900;
  return 37800;
}

const bcd = (v) => ((Math.floor(v / 10) << 4) | (v % 10)) & 255;

/**
 * opts: { sampleRate, channels?, xaRate | level, bits: 4|8 (default 4), file=1, channel=0,
 *         startSector=0 (MSF = startSector + 00:02:00), edc=true }
 * Input with more than 2 channels keeps the first two. The encoder exposes `targetRate`.
 */
function createPsxXa(opts = {}) {
  const srcRate = opts.sampleRate || 44100;
  const targetRate = xaTargetRate(opts);
  const bits8 = opts.bits === 8;
  const fileNo = opts.file == null ? 1 : opts.file & 255;
  const chanNo = opts.channel == null ? 0 : opts.channel & 31;
  const startSector = opts.startSector | 0;
  const wantEdc = opts.edc !== false;
  let nch = 0;
  let chunks = [];

  return {
    targetRate,
    encode(channelArrays) {
      if (!nch) { nch = Math.min(2, channelArrays.length) || 1; chunks = Array.from({ length: nch }, () => []); }
      for (let c = 0; c < nch; c++) chunks[c].push(Float32Array.from(channelArrays[c] || channelArrays[0]));
      return new Uint8Array(0);
    },
    flush() {
      const channels = nch || 1;
      const stereo = channels === 2;
      const data = (chunks.length ? chunks : [[]]).map((list) => {
        const len = list.reduce((a, c) => a + c.length, 0);
        const all = new Float32Array(len);
        let o = 0;
        for (const c of list) { all.set(c, o); o += c.length; }
        return resampleLinear(all, srcRate, targetRate);
      });
      const units = bits8 ? 4 : 8;
      const unitsPerCh = units / channels;
      const chunksPerSector = unitsPerCh * GROUPS;
      const frames = data[0].length;
      const nSec = Math.max(1, Math.ceil(frames / (chunksPerSector * 28)));
      const out = new Uint8Array(nSec * SECTOR);
      const coding = (stereo ? 1 : 0) | (targetRate === 18900 ? 4 : 0) | (bits8 ? 0x10 : 0);
      const st = [{ o1: 0, o2: 0 }, { o1: 0, o2: 0 }];
      const chunkIdx = [0, 0];
      const x = new Float64Array(28);
      for (let s = 0; s < nSec; s++) {
        const b = s * SECTOR;
        for (let i = 0; i < 12; i++) out[b + i] = SYNC[i];
        const frame = startSector + s + 150;
        out[b + 12] = bcd(Math.floor(frame / 4500));
        out[b + 13] = bcd(Math.floor(frame / 75) % 60);
        out[b + 14] = bcd(frame % 75);
        out[b + 15] = 2;
        const submode = 0x64 | (s === nSec - 1 ? 0x81 : 0);
        for (let k = 0; k < 2; k++) {
          const o = b + 16 + k * 4;
          out[o] = fileNo; out[o + 1] = chanNo; out[o + 2] = submode; out[o + 3] = coding;
        }
        for (let g = 0; g < GROUPS; g++) {
          const go = b + 24 + g * 128;
          for (let u = 0; u < units; u++) {
            const ch = stereo ? (u & 1) : 0;
            const idx = chunkIdx[ch]++;
            for (let i = 0; i < 28; i++) {
              const v = data[ch][idx * 28 + i];
              x[i] = v === undefined ? 0 : clamp16(Math.round(v * 32768));
            }
            const e = encodeUnitSearch(x, st[ch], bits8);
            const pb = (e.filter << 4) | e.range;
            if (bits8) {
              for (let k = 0; k < 4; k++) out[go + u + k * 4] = pb; // 4 copies of 4 params
            } else if (u < 4) { out[go + u] = pb; out[go + 4 + u] = pb; }
            else { out[go + 8 + (u - 4)] = pb; out[go + 12 + (u - 4)] = pb; }
            for (let w = 0; w < 28; w++) {
              const q = e.codes[w];
              const p = go + 16 + w * 4;
              if (bits8) out[p + u] = q & 255;
              else if (u & 1) out[p + (u >> 1)] |= (q & 15) << 4;
              else out[p + (u >> 1)] |= q & 15;
            }
          }
        }
        if (wantEdc) {
          const edc = xaEdc(out, b + 16, b + 16 + 8 + DATA_BYTES);
          const o = b + 2348;
          out[o] = edc & 255; out[o + 1] = (edc >>> 8) & 255; out[o + 2] = (edc >>> 16) & 255; out[o + 3] = (edc >>> 24) & 255;
        }
      }
      chunks = []; nch = 0;
      return out;
    },
    free() { chunks = []; nch = 0; }
  };
}

return { decodeXa, create: createPsxXa, XA_INFO, XA_RATES, xaEdc, xaTargetRate };
})();

const nintendoDsp = (() => {
/**
 * Nintendo GameCube / Wii DSP-ADPCM (.dsp) encode and decode.
 *
 * File layout (all big-endian), one 0x60-byte header per channel:
 *   0x00 u32 sample count          0x04 u32 nibble count (incl. frame-header nibbles)
 *   0x08 u32 sample rate           0x0C u16 loop flag      0x0E u16 format (0 = ADPCM)
 *   0x10 u32 loop start (nibble addr)  0x14 u32 loop end (nibble addr)  0x18 u32 current addr (2)
 *   0x1C s16[16] coefficients (8 predictor pairs)  0x3C u16 gain (0)  0x3E u16 initial ps
 *   0x40 s16 hist1  0x42 s16 hist2  0x44 u16 loop ps  0x46 s16 loop hist1  0x48 s16 loop hist2
 *   0x4A u16 channel count  0x4C u16 interleave/block size (8)  0x4E..0x5F padding
 * Data: 8-byte frames (header byte = predictor<<4 | scale exponent, then 14 nibbles = 14 samples).
 *
 * STEREO LAYOUT: a single .dsp with two consecutive 0x60 headers (left at 0x00, right at 0x60), the channel field at 0x4A
 * left at 1 and the block size at 0x4C set to 8, then audio data interleaved in 8-byte units (one frame of left, one frame
 * of right, ...). This is the layout vgmstream's standard-DSP reader decodes (a channel field of 2 is read as something else
 * there); the decoder here accepts both. For split per-channel files use encoder.flushChannels().
 */

const FRAME_SAMPLES = 14;
const FRAME_BYTES = 8;
const HEADER_SIZE = 0x60;

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

function nibbleAddr(sample) {
  return Math.floor(sample / FRAME_SAMPLES) * 16 + (sample % FRAME_SAMPLES) + 2;
}

function nibblesForSamples(n) {
  const full = Math.floor(n / FRAME_SAMPLES);
  const rem = n % FRAME_SAMPLES;
  return full * 16 + (rem ? rem + 2 : 0);
}

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function s16(b, o) { return (u16(b, o) << 16) >> 16; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

// ---------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------

function readHeader(bytes, off) {
  if (bytes.length < off + HEADER_SIZE) throw new Error('DSP: file too short.');
  const h = {
    sampleCount: u32(bytes, off),
    nibbleCount: u32(bytes, off + 4),
    sampleRate: u32(bytes, off + 8),
    loopFlag: u16(bytes, off + 0x0c),
    format: u16(bytes, off + 0x0e),
    loopStart: u32(bytes, off + 0x10),
    loopEnd: u32(bytes, off + 0x14),
    coefs: new Int16Array(16),
    ps: u16(bytes, off + 0x3e),
    hist1: s16(bytes, off + 0x40),
    hist2: s16(bytes, off + 0x42),
    channels: u16(bytes, off + 0x4a),
    blockSize: u16(bytes, off + 0x4c)
  };
  for (let i = 0; i < 16; i++) h.coefs[i] = s16(bytes, off + 0x1c + i * 2);
  return h;
}

function validHeader(h) {
  return h.format === 0 && h.sampleRate > 0 && h.sampleRate <= 384000 &&
    h.sampleCount > 0 && h.nibbleCount === nibblesForSamples(h.sampleCount);
}

function addrToSample(a) {
  return Math.floor(a / 16) * FRAME_SAMPLES + Math.max(0, (a % 16) - 2);
}

function decodeDsp(bytes) {
  const h0 = readHeader(bytes, 0);
  if (!validHeader(h0)) throw new Error('DSP: invalid header.');
  let channels = h0.channels || 1;
  if (channels > 2) throw new Error('DSP: unsupported channel count.');
  // Stereo is also written with a channel field of 1 and a second header right after the first (block size 8).
  if (channels === 1 && h0.blockSize === FRAME_BYTES && bytes.length >= HEADER_SIZE * 2) {
    const h1 = readHeader(bytes, HEADER_SIZE);
    if (validHeader(h1) && h1.sampleCount === h0.sampleCount && h1.sampleRate === h0.sampleRate) channels = 2;
  }
  const headers = [h0];
  if (channels === 2) {
    const h1 = readHeader(bytes, HEADER_SIZE);
    if (!validHeader(h1) || h1.sampleCount !== h0.sampleCount) throw new Error('DSP: invalid second channel header.');
    headers.push(h1);
  }
  const dataStart = HEADER_SIZE * channels;
  const frames = Math.ceil(h0.sampleCount / FRAME_SAMPLES);
  const perChan = frames * FRAME_BYTES;
  if (bytes.length < dataStart + perChan * channels) throw new Error('DSP: truncated audio data.');
  const interleave = channels === 2 ? (h0.blockSize || FRAME_BYTES) : perChan;
  if (interleave % FRAME_BYTES) throw new Error('DSP: unsupported interleave.');
  const channelData = [];
  for (let c = 0; c < channels; c++) {
    const h = headers[c];
    const out = new Float32Array(h.sampleCount);
    let hist1 = h.hist1, hist2 = h.hist2;
    for (let f = 0; f < frames; f++) {
      const byteInChan = f * FRAME_BYTES;
      const blk = Math.floor(byteInChan / interleave);
      const pos = dataStart + (blk * channels + c) * interleave + (byteInChan % interleave);
      const ps = bytes[pos];
      const pred = ps >> 4;
      if (pred > 7) throw new Error('DSP: invalid predictor index.');
      const scale = 1 << (ps & 15);
      const c1 = h.coefs[pred * 2], c2 = h.coefs[pred * 2 + 1];
      const n = Math.min(FRAME_SAMPLES, h.sampleCount - f * FRAME_SAMPLES);
      for (let i = 0; i < n; i++) {
        const byte = bytes[pos + 1 + (i >> 1)];
        let nib = (i & 1) ? byte & 15 : byte >> 4;
        if (nib >= 8) nib -= 16;
        const s = clamp16(((nib * scale) * 2048 + 1024 + c1 * hist1 + c2 * hist2) >> 11);
        hist2 = hist1;
        hist1 = s;
        out[f * FRAME_SAMPLES + i] = s / 32768;
      }
    }
    channelData.push(out);
  }
  const res = { sampleRate: h0.sampleRate, channels, channelData };
  if (h0.loopFlag) res.loop = { start: addrToSample(h0.loopStart), end: addrToSample(h0.loopEnd) };
  return res;
}

// ---------------------------------------------------------------------------
// Encoder: coefficient analysis
// ---------------------------------------------------------------------------

/** Order-2 Levinson-Durbin on autocorrelation r[0..2]; returns [a1, a2] (x^[n] = a1 x[n-1] + a2 x[n-2]). */
function levinson2(r0, r1, r2) {
  if (!(r0 > 1e-9)) return [0, 0];
  r0 *= 1 + 1e-9;
  const k1 = r1 / r0;
  const e1 = r0 * (1 - k1 * k1);
  if (!(e1 > 1e-12 * r0)) return [Math.max(-1.999, Math.min(1.999, k1)), 0];
  const k2 = (r2 - k1 * r1) / e1;
  const a1 = Math.max(-1.999, Math.min(1.999, k1 - k2 * k1));
  const a2 = Math.max(-0.999, Math.min(0.999, k2));
  return [a1, a2];
}

/** Prediction error energy of coefficients (a1,a2) given the autocorrelation of a frame window. */
function predError(a1, a2, r0, r1, r2) {
  return r0 - 2 * a1 * r1 - 2 * a2 * r2 + (a1 * a1 + a2 * a2) * r0 + 2 * a1 * a2 * r1;
}

/**
 * Per-frame autocorrelation (16-sample window: 2 history + 14 samples) + Levinson-Durbin, then
 * Lloyd clustering into 8 predictor pairs; cluster centres are re-derived by summing member
 * autocorrelations and re-solving Levinson-Durbin. Returns Int16Array(16) (coefs scaled by 2048).
 */
function computeDspCoefs(pcm) {
  const n = pcm.length;
  const frames = Math.max(1, Math.ceil(n / FRAME_SAMPLES));
  const R = [];
  const w = new Float64Array(16);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < 16; i++) {
      const idx = f * FRAME_SAMPLES - 2 + i;
      w[i] = idx >= 0 && idx < n ? pcm[idx] : 0;
    }
    let r0 = 0, r1 = 0, r2 = 0;
    for (let i = 0; i < 16; i++) {
      r0 += w[i] * w[i];
      if (i >= 1) r1 += w[i] * w[i - 1];
      if (i >= 2) r2 += w[i] * w[i - 2];
    }
    if (r0 > 16) R.push({ r0, r1, r2, a: levinson2(r0, r1, r2), c: -1 });
  }
  const K = 8;
  const cent = [];
  if (R.length === 0) {
    for (let k = 0; k < K; k++) cent.push([0, 0]);
  } else {
    const sorted = R.slice().sort((x, y) => x.a[0] - y.a[0]);
    for (let k = 0; k < K; k++) {
      const lo = Math.min(sorted.length - 1, Math.floor(k * sorted.length / K));
      const hi = Math.max(lo + 1, Math.floor((k + 1) * sorted.length / K));
      let s0 = 0, s1 = 0, s2 = 0;
      for (let i = lo; i < Math.min(hi, sorted.length); i++) { s0 += sorted[i].r0; s1 += sorted[i].r1; s2 += sorted[i].r2; }
      cent.push(levinson2(s0, s1, s2));
    }
    for (let iter = 0; iter < 24; iter++) {
      const acc = Array.from({ length: K }, () => [0, 0, 0, 0]);
      let moved = 0;
      for (const fr of R) {
        let best = 0, bestE = Infinity;
        for (let k = 0; k < K; k++) {
          const e = predError(cent[k][0], cent[k][1], fr.r0, fr.r1, fr.r2);
          if (e < bestE) { bestE = e; best = k; }
        }
        if (fr.c !== best) { fr.c = best; moved++; }
        const a = acc[best];
        const wgt = 1 / Math.sqrt(fr.r0); // damp loud frames so quiet material still gets predictors
        a[0] += fr.r0 * wgt; a[1] += fr.r1 * wgt; a[2] += fr.r2 * wgt; a[3]++;
      }
      for (let k = 0; k < K; k++) if (acc[k][3] > 0) cent[k] = levinson2(acc[k][0], acc[k][1], acc[k][2]);
      if (!moved) break;
    }
  }
  const coefs = new Int16Array(16);
  for (let k = 0; k < K; k++) {
    coefs[k * 2] = Math.max(-32768, Math.min(32767, Math.round(cent[k][0] * 2048)));
    coefs[k * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(cent[k][1] * 2048)));
  }
  return coefs;
}

/** Encode one channel (array of int16 values). Returns { coefs, data, decoded }. */
function encodeChannel(pcm) {
  const n = pcm.length;
  const coefs = computeDspCoefs(pcm);
  const frames = Math.ceil(n / FRAME_SAMPLES);
  const data = new Uint8Array(frames * FRAME_BYTES);
  const decoded = new Int16Array(frames * FRAME_SAMPLES);
  let h1 = 0, h2 = 0;
  const nibs = new Int8Array(FRAME_SAMPLES);
  const bestNibs = new Int8Array(FRAME_SAMPLES);
  const outTmp = new Int16Array(FRAME_SAMPLES);
  const bestOut = new Int16Array(FRAME_SAMPLES);
  for (let f = 0; f < frames; f++) {
    const base = f * FRAME_SAMPLES;
    let bestErr = Infinity, bestPs = 0;
    for (let p = 0; p < 8; p++) {
      const c1 = coefs[p * 2], c2 = coefs[p * 2 + 1];
      for (let e = 0; e < 16; e++) {
        const scale = 1 << e;
        let a = h1, b = h2, err = 0, clipped = false;
        for (let i = 0; i < FRAME_SAMPLES; i++) {
          const s = base + i < n ? pcm[base + i] : 0;
          const pred = c1 * a + c2 * b;
          let nib = Math.round((s - (pred + 1024) / 2048) / scale);
          if (nib > 7) { nib = 7; clipped = true; } else if (nib < -8) { nib = -8; clipped = true; }
          const o = clamp16(((nib * scale) * 2048 + 1024 + pred) >> 11);
          const d = s - o;
          err += d * d;
          nibs[i] = nib;
          outTmp[i] = o;
          b = a; a = o;
        }
        if (clipped && e < 15) continue;
        if (err < bestErr) {
          bestErr = err; bestPs = (p << 4) | e;
          bestNibs.set(nibs); bestOut.set(outTmp);
        }
        break;
      }
    }
    const o = f * FRAME_BYTES;
    data[o] = bestPs;
    for (let i = 0; i < FRAME_SAMPLES; i += 2) {
      data[o + 1 + (i >> 1)] = ((bestNibs[i] & 15) << 4) | (bestNibs[i + 1] & 15);
    }
    decoded.set(bestOut, base);
    h1 = bestOut[FRAME_SAMPLES - 1];
    h2 = bestOut[FRAME_SAMPLES - 2];
  }
  return { coefs, data, decoded };
}

function writeHeader(out, off, ch, p) {
  const v = new DataView(out.buffer, out.byteOffset + off, HEADER_SIZE);
  const nibbles = nibblesForSamples(p.sampleCount);
  v.setUint32(0, p.sampleCount);
  v.setUint32(4, nibbles);
  v.setUint32(8, p.sampleRate);
  v.setUint16(0x0c, p.loop ? 1 : 0);
  v.setUint16(0x0e, 0);
  v.setUint32(0x10, p.loop ? nibbleAddr(p.loop.start) : 2);
  v.setUint32(0x14, p.loop ? nibbleAddr(p.loop.end) : Math.max(2, nibbles - 1));
  v.setUint32(0x18, 2);
  for (let i = 0; i < 16; i++) v.setInt16(0x1c + i * 2, ch.coefs[i]);
  v.setUint16(0x3c, 0);
  v.setUint16(0x3e, ch.data[0] || 0);
  v.setInt16(0x40, 0);
  v.setInt16(0x42, 0);
  if (p.loop) {
    const frame = Math.floor(p.loop.start / FRAME_SAMPLES);
    v.setUint16(0x44, ch.data[frame * FRAME_BYTES]);
    v.setInt16(0x46, p.loop.start >= 1 ? ch.decoded[p.loop.start - 1] : 0);
    v.setInt16(0x48, p.loop.start >= 2 ? ch.decoded[p.loop.start - 2] : 0);
  }
  v.setUint16(0x4a, 1);
  v.setUint16(0x4c, p.channels === 2 ? FRAME_BYTES : 0);
}

/**
 * opts: { sampleRate, channels? (1|2), loopStart?, loopEnd? (sample indices; loopEnd = last
 * sample of the loop) }.  Loop points are stored in the header only (decoders ignore them).
 */
function createNintendoDsp(opts) {
  const sampleRate = opts.sampleRate | 0;
  let nch = opts.channels || 0;
  let pcm = [];

  function appendPcm(channelArrays) {
    if (!nch) nch = channelArrays.length;
    if (nch > 2) throw new Error('DSP: only mono or stereo is supported.');
    if (!pcm.length) pcm = Array.from({ length: nch }, () => []);
    const len = channelArrays[0].length;
    for (let c = 0; c < nch; c++) {
      const src = channelArrays[c] || channelArrays[0];
      const dst = pcm[c];
      for (let i = 0; i < len; i++) {
        const s = Math.max(-1, Math.min(1, src[i] || 0));
        dst.push(Math.round(s < 0 ? s * 32768 : s * 32767));
      }
    }
  }

  function build() {
    const channels = pcm.length;
    const total = channels ? pcm[0].length : 0;
    if (total === 0) throw new Error('DSP: no audio data.');
    let loop = null;
    if (opts.loopStart != null && opts.loopEnd != null) {
      const s = Math.max(0, opts.loopStart | 0);
      const e = Math.min(total - 1, opts.loopEnd | 0);
      if (e > s) loop = { start: s, end: e };
    }
    return { channels, total, loop, chs: pcm.map(encodeChannel) };
  }

  return {
    encode(channelArrays) {
      appendPcm(channelArrays);
      return new Uint8Array(0);
    },
    flush() {
      const { channels, total, loop, chs } = build();
      const frames = Math.ceil(total / FRAME_SAMPLES);
      const out = new Uint8Array(HEADER_SIZE * channels + frames * FRAME_BYTES * channels);
      const p = { sampleCount: total, sampleRate, loop, channels };
      for (let c = 0; c < channels; c++) writeHeader(out, c * HEADER_SIZE, chs[c], p);
      const ds = HEADER_SIZE * channels;
      for (let f = 0; f < frames; f++) {
        for (let c = 0; c < channels; c++) {
          out.set(chs[c].data.subarray(f * FRAME_BYTES, (f + 1) * FRAME_BYTES), ds + (f * channels + c) * FRAME_BYTES);
        }
      }
      pcm = [];
      return out;
    },
    /** Standalone mono .dsp file per channel (alternative to the interleaved stereo file). */
    flushChannels() {
      const { total, loop, chs } = build();
      const frames = Math.ceil(total / FRAME_SAMPLES);
      const files = chs.map((ch) => {
        const out = new Uint8Array(HEADER_SIZE + frames * FRAME_BYTES);
        writeHeader(out, 0, ch, { sampleCount: total, sampleRate, loop, channels: 1 });
        out.set(ch.data, HEADER_SIZE);
        return out;
      });
      pcm = [];
      return files;
    },
    free() {
      pcm = [];
    }
  };
}

const DSP_INFO = {
  id: 'dsp',
  label: 'Nintendo DSP-ADPCM',
  extensions: ['dsp'],
  mime: 'audio/x-nintendo-dsp',
  sniff(bytes) {
    if (!bytes || bytes.length < HEADER_SIZE) return false;
    const h = readHeader(bytes, 0);
    return validHeader(h) && u32(bytes, 0x18) >= 2 && h.channels <= 2;
  }
};

return { decodeDsp, create: createNintendoDsp, DSP_INFO, computeDspCoefs };
})();

const criAdx = (() => {
/**
 * CRI ADX (.adx) encode and decode: standard ADX (encoding type 3), 4-bit, 18-byte blocks
 * (2-byte big-endian scale + 16 bytes = 32 samples) per channel, channels interleaved per block.
 *
 * Header (big-endian): 0x00 u16 0x8000, 0x02 u16 copyright offset (data starts at +4, the
 * "(c)CRI" string ends exactly there), 0x04 u8 encoding (3), 0x05 u8 block size (18),
 * 0x06 u8 bit depth (4), 0x07 u8 channels, 0x08 u32 sample rate, 0x0C u32 total samples,
 * 0x10 u16 highpass cutoff, 0x12 u8 version (3 or 4), 0x13 u8 flags.
 * Loop info: v3 at 0x18 (flag, start sample, start byte, end sample, end byte);
 *            v4 at 0x24 (same five u32 fields).
 * Predictor: x[n] = nibble * scale + ((coef1*x[n-1] + coef2*x[n-2]) >> 12), with
 * coef derived from cutoff (see calcCoefs). scale field = (step - 1) & 0x1FFF.
 * A terminating block (0x8001, 0x000E, zeros) is appended. AHX is not supported.
 *
 * Notes: scale is stored as step-1 and decoded as stored+1 (as in CRI's and vgmstream's decoders); the decoder stops at the end
 * marker and trims, so files whose header counts the terminator block's 32 samples still decode to the right length.
 * Coefficients are C-truncated ((short) casts), not floor()ed.
 */

const BLOCK_SIZE = 18;
const BLOCK_SAMPLES = 32;

function clamp16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

function calcCoefs(cutoff, sampleRate) {
  const a = Math.SQRT2 - Math.cos(2 * Math.PI * cutoff / sampleRate);
  const b = Math.SQRT2 - 1;
  const c = (a - Math.sqrt((a + b) * (a - b))) / b;
  // C-style truncation toward zero ((short) cast in CRI/vgmstream, (int) in ffmpeg): floor() would make
  // coef2 one lower (-2635 vs -2634 at 500 Hz / 22.05 kHz), a bit-inexact decode of every real ADX file.
  return [Math.trunc(c * 8192), Math.trunc(c * c * -4096)];
}

function u16(b, o) { return (b[o] << 8) | b[o + 1]; }
function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

function hasCopyright(bytes) {
  if (bytes.length < 0x14 || bytes[0] !== 0x80 || bytes[1] !== 0) return false;
  const start = u16(bytes, 2) + 4;
  if (start < 0x18 || start > bytes.length) return false;
  const tag = '(c)CRI';
  for (let i = 0; i < 6; i++) if (bytes[start - 6 + i] !== tag.charCodeAt(i)) return false;
  return true;
}

function decodeAdx(bytes) {
  if (!hasCopyright(bytes)) throw new Error('ADX: invalid header.');
  const dataStart = u16(bytes, 2) + 4;
  const encoding = bytes[4];
  const blockSize = bytes[5];
  const bits = bytes[6];
  const channels = bytes[7];
  const sampleRate = u32(bytes, 8);
  const total = u32(bytes, 12);
  const cutoff = u16(bytes, 0x10);
  const version = bytes[0x12];
  if (encoding !== 3) throw new Error('ADX: unsupported encoding type (only standard ADX).');
  if (blockSize !== BLOCK_SIZE || bits !== 4) throw new Error('ADX: unsupported block size / bit depth.');
  if (channels < 1 || channels > 8) throw new Error('ADX: invalid channel count.');
  if (sampleRate < 1) throw new Error('ADX: invalid sample rate.');
  if (bytes[0x13] & 8) throw new Error('ADX: encrypted files are not supported.');
  const [c1, c2] = calcCoefs(cutoff, sampleRate);

  let out = Array.from({ length: channels }, () => new Float32Array(total));
  let decodedGroups = Math.ceil(total / BLOCK_SAMPLES);
  const hist1 = new Int32Array(channels), hist2 = new Int32Array(channels);
  const groups = Math.ceil(total / BLOCK_SAMPLES);
  let pos = dataStart;
  for (let g = 0; g < groups; g++) {
    for (let c = 0; c < channels; c++) {
      if (pos + BLOCK_SIZE > bytes.length) throw new Error('ADX: truncated audio data.');
      const raw = u16(bytes, pos);
      if (raw & 0x8000) {
        // End-of-stream marker before `total` samples: ffmpeg's muxer writes a header sample count
        // that includes the 32 samples of the terminator block, so stop here and trim.
        if (g === 0) throw new Error('ADX: unexpected end block.');
        decodedGroups = g;
        break;
      }
      const scale = (raw & 0x1fff) + 1;
      let h1 = hist1[c], h2 = hist2[c];
      const n = Math.min(BLOCK_SAMPLES, total - g * BLOCK_SAMPLES);
      for (let i = 0; i < n; i++) {
        const byte = bytes[pos + 2 + (i >> 1)];
        let nib = (i & 1) ? byte & 15 : byte >> 4;
        if (nib >= 8) nib -= 16;
        const s = clamp16(nib * scale + ((c1 * h1 + c2 * h2) >> 12));
        h2 = h1; h1 = s;
        out[c][g * BLOCK_SAMPLES + i] = s / 32768;
      }
      // keep history running through a short final block as well (irrelevant afterwards)
      hist1[c] = h1; hist2[c] = h2;
      pos += BLOCK_SIZE;
    }
    if (decodedGroups !== Math.ceil(total / BLOCK_SAMPLES)) break;
  }
  if (decodedGroups * BLOCK_SAMPLES < total) out = out.map((a) => a.slice(0, decodedGroups * BLOCK_SAMPLES));
  const res = { sampleRate, channels, channelData: out };
  const lo = version === 4 ? 0x24 : version === 3 ? 0x18 : -1;
  if (lo >= 0 && dataStart >= lo + 20 + 6 && u32(bytes, lo) !== 0) {
    res.loop = { start: u32(bytes, lo + 4), end: u32(bytes, lo + 12) };
  }
  return res;
}

/**
 * opts: { sampleRate, channels?, cutoff? (default 500), version? (3|4, default 4),
 *         loopStart?, loopEnd? (samples; 32-sample aligned start recommended) }
 */
function createCriAdx(opts) {
  const sampleRate = opts.sampleRate | 0;
  const cutoff = opts.cutoff != null ? opts.cutoff | 0 : 500;
  const version = opts.version === 3 ? 3 : 4;
  let nch = opts.channels || 0;
  let pcm = [];

  return {
    encode(channelArrays) {
      if (!nch) nch = channelArrays.length;
      if (nch > 8) throw new Error('ADX: at most 8 channels.');
      if (!pcm.length) pcm = Array.from({ length: nch }, () => []);
      const len = channelArrays[0].length;
      for (let c = 0; c < nch; c++) {
        const src = channelArrays[c] || channelArrays[0];
        const dst = pcm[c];
        for (let i = 0; i < len; i++) {
          const s = Math.max(-1, Math.min(1, src[i] || 0));
          dst.push(Math.round(s < 0 ? s * 32768 : s * 32767));
        }
      }
      return new Uint8Array(0);
    },
    flush() {
      const channels = pcm.length;
      const total = channels ? pcm[0].length : 0;
      if (!total) throw new Error('ADX: no audio data.');
      let loop = null;
      if (opts.loopStart != null && opts.loopEnd != null) {
        const s = Math.max(0, opts.loopStart | 0);
        const e = Math.min(total, opts.loopEnd | 0);
        if (e > s) loop = { start: s, end: e };
      }
      const [c1, c2] = calcCoefs(cutoff, sampleRate);
      const groups = Math.ceil(total / BLOCK_SAMPLES);
      // header sizing: "(c)CRI" ends at data start; loop fields must not overlap it
      let copyrightOffset = 0x20;
      if (loop) copyrightOffset = version === 4 ? 0x40 : 0x34;
      const dataStart = copyrightOffset + 4;
      const out = new Uint8Array(dataStart + groups * channels * BLOCK_SIZE + BLOCK_SIZE);
      const v = new DataView(out.buffer);
      v.setUint16(0, 0x8000);
      v.setUint16(2, copyrightOffset);
      out[4] = 3; out[5] = BLOCK_SIZE; out[6] = 4; out[7] = channels;
      v.setUint32(8, sampleRate);
      v.setUint32(12, total);
      v.setUint16(0x10, cutoff);
      out[0x12] = version; out[0x13] = 0;
      if (loop) {
        const lo = version === 4 ? 0x24 : 0x18;
        const startByte = dataStart + Math.floor(loop.start / BLOCK_SAMPLES) * BLOCK_SIZE * channels;
        const endByte = dataStart + Math.ceil(loop.end / BLOCK_SAMPLES) * BLOCK_SIZE * channels;
        v.setUint32(lo, 1);
        v.setUint32(lo + 4, loop.start);
        v.setUint32(lo + 8, startByte);
        v.setUint32(lo + 12, loop.end);
        v.setUint32(lo + 16, endByte);
      }
      for (let i = 0; i < 6; i++) out[dataStart - 6 + i] = '(c)CRI'.charCodeAt(i);

      const hist1 = new Int32Array(channels), hist2 = new Int32Array(channels);
      const blk = new Int32Array(BLOCK_SAMPLES);
      const nibs = new Int8Array(BLOCK_SAMPLES);
      const rec = new Int32Array(BLOCK_SAMPLES);
      let pos = dataStart;
      for (let g = 0; g < groups; g++) {
        for (let c = 0; c < channels; c++) {
          const x = pcm[c];
          const base = g * BLOCK_SAMPLES;
          for (let i = 0; i < BLOCK_SAMPLES; i++) blk[i] = base + i < total ? x[base + i] : 0;
          // open-loop estimate of the step from prediction residuals of the source signal
          let a = hist1[c], b = hist2[c], maxPos = 0, maxNeg = 0;
          for (let i = 0; i < BLOCK_SAMPLES; i++) {
            const d = blk[i] - ((c1 * a + c2 * b) >> 12);
            if (d > maxPos) maxPos = d;
            if (-d > maxNeg) maxNeg = -d;
            b = a; a = blk[i];
          }
          let step = Math.max(1, Math.ceil(Math.max(maxPos / 7, maxNeg / 8)));
          let best = null;
          for (let tries = 0; tries < 64; tries++) {
            if (step > 0x2000) step = 0x2000;
            let h1 = hist1[c], h2 = hist2[c], clipped = false;
            for (let i = 0; i < BLOCK_SAMPLES; i++) {
              const pred = (c1 * h1 + c2 * h2) >> 12;
              let nib = Math.round((blk[i] - pred) / step);
              if (nib > 7) { nib = 7; clipped = true; } else if (nib < -8) { nib = -8; clipped = true; }
              const o = clamp16(nib * step + pred);
              nibs[i] = nib; rec[i] = o;
              h2 = h1; h1 = o;
            }
            if (!clipped || step >= 0x2000) { best = { step, h1, h2 }; break; }
            step = Math.max(step + 1, Math.ceil(step * 1.1));
          }
          v.setUint16(pos, best.step - 1);
          for (let i = 0; i < BLOCK_SAMPLES; i += 2) {
            out[pos + 2 + (i >> 1)] = ((nibs[i] & 15) << 4) | (nibs[i + 1] & 15);
          }
          hist1[c] = best.h1; hist2[c] = best.h2;
          pos += BLOCK_SIZE;
        }
      }
      // end block: 0x8001, remaining-length 0x000E, zero padding
      out[pos] = 0x80; out[pos + 1] = 0x01; out[pos + 2] = 0x00; out[pos + 3] = 0x0e;
      pcm = [];
      return out;
    },
    free() {
      pcm = [];
    }
  };
}

const ADX_INFO = {
  id: 'adx',
  label: 'CRI ADX',
  extensions: ['adx'],
  mime: 'audio/x-adx',
  sniff(bytes) {
    return !!bytes && hasCopyright(bytes) && bytes[4] === 3;
  }
};

return { decodeAdx, create: createCriAdx, ADX_INFO };
})();

const yamaha = (() => {
const { resampleChannels, remixChannels, concatChannelChunks, floatToInt16, buildWav, parseWav, isWav } = wavutil;
/**
 * Yamaha ADPCM-B (AICA / YMZ280B / Y8950 family), 4-bit.
 * Raw .aica-style stream (low nibble first, ffmpeg "adpcm_yamaha") and WAV tag 0x0020.
 * Multi-channel (max 2): nibbles are interleaved sample-major (ch0 = low nibble).
 */

const YAMAHA_WAV_TAG = 0x0020;

const INDEX_SCALE = [230, 230, 230, 230, 307, 409, 512, 614];
const STEP_MIN = 127;
const STEP_MAX = 24576;

const YAMAHA_AICA_INFO = {
  id: 'yamaha-aica',
  label: 'Yamaha ADPCM-B (AICA)',
  extensions: ['aica'],
  mime: 'audio/x-aica',
  container: 'raw',
  sniff: () => false
};

const YAMAHA_WAV_INFO = {
  id: 'yamaha-adpcm-wav',
  label: 'Yamaha ADPCM (WAV)',
  extensions: ['wav'],
  mime: 'audio/wav',
  container: 'wav',
  sniff(bytes) {
    return bytes.length >= 22 && isWav(bytes) && (bytes[20] | (bytes[21] << 8)) === YAMAHA_WAV_TAG;
  }
};

const YAMAHA_INFO = YAMAHA_AICA_INFO;

function createYamahaState(leak) {
  return { pred: 0, step: STEP_MIN, leak: !!leak };
}

function yamahaExpand(st, nib) {
  const mag = nib & 7;
  const delta = Math.trunc((st.step * (2 * mag + 1)) / 8);
  // AICA (Dreamcast) variant: the predictor leaks by 254/256 every sample (bit-exact with vgmstream's AICA decoder).
  const base = st.leak ? Math.trunc(st.pred * 254 / 256) : st.pred;
  let p = base + ((nib & 8) ? -delta : delta);
  if (p > 32767) p = 32767; else if (p < -32768) p = -32768;
  st.pred = p;
  let s = (st.step * INDEX_SCALE[mag]) >> 8;
  st.step = s < STEP_MIN ? STEP_MIN : s > STEP_MAX ? STEP_MAX : s;
  return p;
}

function yamahaEncodeSample(st, x) {
  let diff = x - (st.leak ? Math.trunc(st.pred * 254 / 256) : st.pred);
  let nib = 0;
  if (diff < 0) { nib = 8; diff = -diff; }
  let m = Math.floor((diff * 4) / st.step);
  if (m > 7) m = 7;
  nib |= m;
  yamahaExpand(st, nib);
  return nib;
}

function encodeYamahaPcm16(channelPcm, nibbleOrder = 'low', leak = false) {
  const nch = channelPcm.length;
  const frames = channelPcm[0].length;
  const states = channelPcm.map(() => createYamahaState(leak));
  const bytes = new Uint8Array(Math.ceil((frames * nch) / 2));
  const lowFirst = nibbleOrder !== 'high';
  let n = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, n++) {
      const nib = yamahaEncodeSample(states[c], channelPcm[c][i]);
      const low = lowFirst ? !(n & 1) : !!(n & 1);
      bytes[n >> 1] |= low ? nib : nib << 4;
    }
  }
  return bytes;
}

function decodeYamahaNibbles(bytes, nch, sampleLimit, nibbleOrder = 'low', leak = false) {
  const total = bytes.length * 2;
  let frames = Math.floor(total / nch);
  if (sampleLimit >= 0 && sampleLimit < frames) frames = sampleLimit;
  const lowFirst = nibbleOrder !== 'high';
  const states = Array.from({ length: nch }, () => createYamahaState(leak));
  const channelData = Array.from({ length: nch }, () => new Float32Array(frames));
  let n = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, n++) {
      const b = bytes[n >> 1];
      const low = lowFirst ? !(n & 1) : !!(n & 1);
      const nib = low ? b & 15 : b >> 4;
      channelData[c][i] = yamahaExpand(states[c], nib) / 32768;
    }
  }
  return channelData;
}

function finishDecode(res, opts) {
  if (opts && opts.outputRate && opts.outputRate !== res.sampleRate) {
    res.channelData = resampleChannels(res.channelData, res.sampleRate, opts.outputRate);
    res.sampleRate = opts.outputRate;
  }
  return res;
}

/** Raw stream. opts: { sampleRate = 44100, channels = 1, nibbleOrder = 'low'|'high', variant = 'ym'|'aica', outputRate }. */
function decodeYamahaRaw(bytes, opts = {}) {
  if (!bytes || !bytes.length) throw new Error('Empty Yamaha ADPCM data.');
  const channels = opts.channels || 1;
  if (channels < 1 || channels > 2) throw new Error('Unsupported channel count.');
  const channelData = decodeYamahaNibbles(bytes, channels, -1, opts.nibbleOrder, opts.variant === 'aica');
  return finishDecode({ sampleRate: opts.sampleRate || 44100, channels, channelData }, opts);
}

function decodeYamahaAdpcmWav(bytes, opts = {}) {
  const w = parseWav(bytes);
  if (w.formatTag !== YAMAHA_WAV_TAG) throw new Error('WAV is not Yamaha ADPCM.');
  if (w.channels < 1 || w.channels > 2) throw new Error('Unsupported channel count.');
  if (!w.sampleRate) throw new Error('Invalid sample rate.');
  const channelData = decodeYamahaNibbles(w.data, w.channels, w.factSamples, opts.nibbleOrder, opts.variant === 'aica');
  return finishDecode({ sampleRate: w.sampleRate, channels: w.channels, channelData }, opts);
}

function decodeYamahaAdpcm(bytes, opts = {}) {
  if (isWav(bytes)) return decodeYamahaAdpcmWav(bytes, opts);
  return decodeYamahaRaw(bytes, opts);
}

/**
 * opts: { sampleRate, channels (default min(2, input channels)), container = 'wav'|'raw',
 *         codecRate (optional: resample to this rate), nibbleOrder, variant = 'ym' | 'aica' (leaky predictor, Dreamcast) }
 */
function createYamahaAdpcm(opts = {}) {
  const inRate = opts.sampleRate || 44100;
  const container = opts.container === 'raw' ? 'raw' : 'wav';
  const codecRate = typeof opts.codecRate === 'number' ? opts.codecRate : inRate;
  let chunks = [];
  let nIn = 0;

  return {
    encode(channelArrays) {
      if (!nIn) nIn = channelArrays.length;
      for (let c = 0; c < nIn; c++) (chunks[c] || (chunks[c] = [])).push(Float32Array.from(channelArrays[c]));
      return new Uint8Array(0);
    },
    flush() {
      const outChannels = Math.min(2, Math.max(1, opts.channels || nIn || 1));
      let arrays = concatChannelChunks(chunks, nIn || 1);
      chunks = [];
      arrays = remixChannels(arrays, outChannels);
      arrays = resampleChannels(arrays, inRate, codecRate);
      const pcm = arrays.map((a) => {
        const o = new Int16Array(a.length);
        for (let i = 0; i < a.length; i++) o[i] = floatToInt16(a[i]);
        return o;
      });
      const data = encodeYamahaPcm16(pcm, opts.nibbleOrder, opts.variant === 'aica');
      if (container === 'raw') return data;
      return buildWav({
        formatTag: YAMAHA_WAV_TAG,
        channels: outChannels,
        sampleRate: codecRate,
        byteRate: Math.ceil((codecRate * outChannels) / 2),
        blockAlign: 1,
        bitsPerSample: 4,
        frames: pcm[0].length,
        data
      });
    },
    free() { chunks = []; }
  };
}

return { decodeYamahaAdpcm, decodeYamahaRaw, decodeYamahaAdpcmWav, create: createYamahaAdpcm, YAMAHA_WAV_INFO, YAMAHA_AICA_INFO };
})();

const oki = (() => {
const { resampleChannels, remixChannels, concatChannelChunks, floatToInt16, buildWav, parseWav, isWav } = wavutil;
/**
 * Dialogic / OKI (VOX) 4-bit ADPCM (MSM6258 style), computed in a 16-bit domain.
 * Raw .vox stream (high nibble first) and WAV format tag 0x0010.
 * Multi-channel (max 2): nibbles are interleaved sample-major (ch0 = high nibble).
 */

const OKI_WAV_TAG = 0x0010;

const OKI_STEP_TABLE = [
  16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66,
  73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
  337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552
];
const INDEX_ADJ = [-1, -1, -1, -1, 2, 4, 6, 8];

const OKI_VOX_INFO = {
  id: 'oki-vox',
  label: 'Dialogic/OKI ADPCM (VOX)',
  extensions: ['vox'],
  mime: 'audio/x-vox',
  container: 'raw',
  sniff: () => false // headerless stream: identified by extension only
};

const OKI_WAV_INFO = {
  id: 'oki-adpcm-wav',
  label: 'OKI ADPCM (WAV)',
  extensions: ['wav'],
  mime: 'audio/wav',
  container: 'wav',
  sniff(bytes) {
    return bytes.length >= 22 && isWav(bytes) && (bytes[20] | (bytes[21] << 8)) === OKI_WAV_TAG;
  }
};

const OKI_INFO = OKI_VOX_INFO;

function createOkiState() {
  return { pred: 0, idx: 0 };
}

/** OKI nibble expansion in the 16-bit domain (the step table x 16, so the fraction bits are kept; bit-exact with vgmstream's OKI4S). Returns the 16-bit predictor. */
function okiExpand(st, nib) {
  const step = OKI_STEP_TABLE[st.idx] * 16;
  const diff = ((2 * (nib & 7) + 1) * step) >> 3;
  let p = st.pred + ((nib & 8) ? -diff : diff);
  if (p > 32767) p = 32767; else if (p < -32768) p = -32768;
  st.pred = p;
  let i = st.idx + INDEX_ADJ[nib & 7];
  st.idx = i < 0 ? 0 : i > 48 ? 48 : i;
  return p;
}

function okiEncodeSample(st, x16) {
  let diff = x16 - st.pred;
  let nib = 0;
  if (diff < 0) { nib = 8; diff = -diff; }
  let m = Math.floor((diff * 4) / (OKI_STEP_TABLE[st.idx] * 16));
  if (m > 7) m = 7;
  nib |= m;
  okiExpand(st, nib);
  return nib;
}

/** Encode Int16 interleaved-by-channel PCM arrays (Int16Array per channel) to a nibble-packed stream. */
function encodeOkiPcm16(channelPcm) {
  const nch = channelPcm.length;
  const frames = channelPcm[0].length;
  const states = channelPcm.map(createOkiState);
  const bytes = new Uint8Array(Math.ceil((frames * nch) / 2));
  let n = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, n++) {
      const nib = okiEncodeSample(states[c], channelPcm[c][i]);
      bytes[n >> 1] |= (n & 1) ? nib : nib << 4;
    }
  }
  return bytes;
}

function decodeOkiNibbles(bytes, nch, sampleLimit) {
  const total = bytes.length * 2;
  let frames = Math.floor(total / nch);
  if (sampleLimit >= 0 && sampleLimit < frames) frames = sampleLimit;
  const states = Array.from({ length: nch }, createOkiState);
  const channelData = Array.from({ length: nch }, () => new Float32Array(frames));
  let n = 0;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nch; c++, n++) {
      const b = bytes[n >> 1];
      const nib = (n & 1) ? b & 15 : b >> 4;
      channelData[c][i] = okiExpand(states[c], nib) / 32768;
    }
  }
  return channelData;
}

function finishDecode(res, opts) {
  if (opts && opts.outputRate && opts.outputRate !== res.sampleRate) {
    res.channelData = resampleChannels(res.channelData, res.sampleRate, opts.outputRate);
    res.sampleRate = opts.outputRate;
  }
  return res;
}

/** Raw .vox stream. opts: { sampleRate = 8000, channels = 1, outputRate }. */
function decodeOkiVox(bytes, opts = {}) {
  if (!bytes || !bytes.length) throw new Error('Empty VOX data.');
  const channels = opts.channels || 1;
  if (channels < 1 || channels > 2) throw new Error('Unsupported channel count.');
  const channelData = decodeOkiNibbles(bytes, channels, -1);
  return finishDecode({ sampleRate: opts.sampleRate || 8000, channels, channelData }, opts);
}

function decodeOkiAdpcmWav(bytes, opts = {}) {
  const w = parseWav(bytes);
  if (w.formatTag !== OKI_WAV_TAG) throw new Error('WAV is not OKI ADPCM.');
  if (w.channels < 1 || w.channels > 2) throw new Error('Unsupported channel count.');
  if (!w.sampleRate) throw new Error('Invalid sample rate.');
  const channelData = decodeOkiNibbles(w.data, w.channels, w.factSamples);
  return finishDecode({ sampleRate: w.sampleRate, channels: w.channels, channelData }, opts);
}

/** Auto-detect: WAV (tag 0x0010) or raw VOX. */
function decodeOkiAdpcm(bytes, opts = {}) {
  if (isWav(bytes)) return decodeOkiAdpcmWav(bytes, opts);
  return decodeOkiVox(bytes, opts);
}

/**
 * opts: { sampleRate (input rate), channels = 1 (1|2), container = 'wav'|'raw',
 *         variant = '8k'|'6k', codecRate (explicit rate; 'native' keeps input rate) }
 */
function createOkiAdpcm(opts = {}) {
  const inRate = opts.sampleRate || 8000;
  const container = opts.container === 'raw' ? 'raw' : 'wav';
  const outChannels = Math.min(2, Math.max(1, opts.channels || 1));
  let codecRate = opts.codecRate || (opts.variant === '6k' ? 6000 : 8000);
  if (codecRate === 'native') codecRate = inRate;
  let chunks = [];
  let nIn = 0;

  return {
    encode(channelArrays) {
      if (!nIn) nIn = channelArrays.length;
      for (let c = 0; c < nIn; c++) (chunks[c] || (chunks[c] = [])).push(Float32Array.from(channelArrays[c]));
      return new Uint8Array(0);
    },
    flush() {
      let arrays = concatChannelChunks(chunks, nIn || 1);
      chunks = [];
      arrays = remixChannels(arrays, outChannels);
      arrays = resampleChannels(arrays, inRate, codecRate);
      const pcm = arrays.map((a) => {
        const o = new Int16Array(a.length);
        for (let i = 0; i < a.length; i++) o[i] = floatToInt16(a[i]);
        return o;
      });
      const data = encodeOkiPcm16(pcm);
      if (container === 'raw') return data;
      return buildWav({
        formatTag: OKI_WAV_TAG,
        channels: outChannels,
        sampleRate: codecRate,
        byteRate: Math.ceil((codecRate * outChannels) / 2),
        blockAlign: 1,
        bitsPerSample: 4,
        frames: pcm[0].length,
        data
      });
    },
    free() { chunks = []; }
  };
}

return { decodeOkiAdpcm, decodeOkiVox, decodeOkiAdpcmWav, create: createOkiAdpcm, OKI_WAV_INFO, OKI_VOX_INFO };
})();

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const version = '1.0.0';

const FORMATS = [
  { id: 'vag', label: 'PlayStation VAG (SPU-ADPCM)', extensions: ['vag', 'vagi'], console: 'PlayStation, PS2', headerless: false,
    sniff: psxVag.VAG_INFO.sniff, decode: psxVag.decodeVag, make: psxVag.create },
  { id: 'vb', label: 'PlayStation VB (raw SPU-ADPCM)', extensions: ['vb'], console: 'PlayStation, PS2', headerless: true,
    sniff: () => false, decode: psxVag.decodeVb, make: (o) => psxVag.create(Object.assign({}, o, { format: 'vb' })) },
  { id: 'xa', label: 'PlayStation CD-ROM XA ADPCM', extensions: ['xa'], console: 'PlayStation CD streams', headerless: false,
    sniff: psxXa.XA_INFO.sniff, decode: psxXa.decodeXa, make: psxXa.create },
  { id: 'dsp', label: 'Nintendo DSP-ADPCM', extensions: ['dsp'], console: 'GameCube, Wii', headerless: false,
    sniff: nintendoDsp.DSP_INFO.sniff, decode: nintendoDsp.decodeDsp, make: nintendoDsp.create },
  { id: 'adx', label: 'CRI ADX', extensions: ['adx'], console: 'Dreamcast, PS2, arcade, many others', headerless: false,
    sniff: criAdx.ADX_INFO.sniff, decode: criAdx.decodeAdx, make: criAdx.create },
  { id: 'aica', label: 'Yamaha ADPCM-B, raw (AICA)', extensions: ['aica'], console: 'Dreamcast AICA, Yamaha sound chips', headerless: true,
    sniff: () => false, decode: (b, o) => yamaha.decodeYamahaRaw(b, Object.assign({ variant: 'aica' }, o)), make: (o) => yamaha.create(Object.assign({ variant: 'aica' }, o, { container: 'raw' })) },
  { id: 'yamaha-wav', label: 'Yamaha ADPCM in WAV (tag 0x0020)', extensions: ['wav'], console: 'Yamaha sound chips', headerless: false,
    sniff: yamaha.YAMAHA_WAV_INFO.sniff, decode: yamaha.decodeYamahaAdpcmWav, make: (o) => yamaha.create(Object.assign({}, o, { container: 'wav' })) },
  { id: 'vox', label: 'OKI / Dialogic ADPCM, raw (VOX)', extensions: ['vox'], console: 'arcade boards, MSM6258 / MSM6295 style chips', headerless: true,
    sniff: () => false, decode: oki.decodeOkiVox, make: (o) => oki.create(Object.assign({}, o, { container: 'raw' })) },
  { id: 'oki-wav', label: 'OKI ADPCM in WAV (tag 0x0010)', extensions: ['wav'], console: 'arcade boards', headerless: false,
    sniff: oki.OKI_WAV_INFO.sniff, decode: oki.decodeOkiAdpcmWav, make: (o) => oki.create(Object.assign({}, o, { container: 'wav' })) }
];
const byId = (id) => FORMATS.find((f) => f.id === id);

/** The format id of `bytes` by content, or null. VB, AICA and VOX are headerless: pass { format } instead. */
function detect(bytes) {
  if (!bytes || !bytes.length) return null;
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  for (const f of FORMATS) { let ok = false; try { ok = f.sniff(bytes); } catch (e) { ok = false; } if (ok) return f.id; }
  return null;
}

/** Decode any supported file. opts.format overrides detection (required for headerless data). Other opts go to the format's decoder. */
function decode(bytes, opts) {
  opts = opts || {};
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const id = opts.format || detect(bytes);
  if (!id) throw new Error('gamedac: unrecognised format (headerless VB, AICA and VOX data needs { format })');
  const f = byId(id);
  if (!f) throw new Error('gamedac: unknown format ' + id);
  const res = f.decode(bytes, opts);
  res.format = id;
  return res;
}

function planar(o) {
  const conv = (a) => { if (!(a instanceof Int16Array)) return a; const f = new Float32Array(a.length); for (let i = 0; i < a.length; i++) f[i] = a[i] / 32768; return f; };
  if (o.interleaved) {
    const n = o.numChannels | 0, src = o.interleaved;
    if (n < 1) throw new Error('gamedac: numChannels required with interleaved');
    const len = Math.floor(src.length / n), out = [];
    for (let c = 0; c < n; c++) { const a = new Float32Array(len); for (let i = 0; i < len; i++) a[i] = src[i * n + c] * (src instanceof Int16Array ? 1 / 32768 : 1); out.push(a); }
    return out;
  }
  if (!Array.isArray(o.channels) || !o.channels.length) throw new Error('gamedac: channels (array of typed arrays) or interleaved required');
  const len = o.channels[0].length;
  for (const c of o.channels) if (c.length !== len) throw new Error('gamedac: all channels must have the same length');
  return o.channels.map(conv);
}

/** Encode. options: format, channels (Float32Array[] or Int16Array[]) or interleaved + numChannels, sampleRate, plus format options (see README). */
function encode(options) {
  const o = options || {};
  let id = o.format;
  if (id === 'vagi') id = 'vag';
  const f = byId(id);
  if (!f) throw new Error('gamedac: unknown or missing format ' + o.format + ' (use one of ' + FORMATS.map((x) => x.id).join(', ') + ')');
  if (!(o.sampleRate > 0)) throw new Error('gamedac: sampleRate required');
  const ch = planar(o);
  const opts = Object.assign({}, o);
  delete opts.channels; delete opts.interleaved; delete opts.numChannels; delete opts.format;
  if (o.outChannels) opts.channels = o.outChannels | 0;
  if (o.format === 'vagi') opts.interleave = true;
  const e = f.make(opts);
  e.encode(ch);
  const out = o.split && id === 'dsp' ? e.flushChannels() : e.flush();
  e.free();
  return out;
}

/** A plain 16-bit PCM WAV from a decode() result (loop points are not written). */
function toWav(decoded, opts) {
  const chs = decoded.channelData, n = chs[0].length, nch = chs.length, sr = decoded.sampleRate;
  const out = new Uint8Array(44 + n * nch * 2), v = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n * nch * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true); v.setUint32(28, sr * nch * 2, true); v.setUint16(32, nch * 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n * nch * 2, true);
  let p = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) { const s = chs[c][i]; v.setInt16(p, s < 0 ? Math.max(-32768, Math.round(s * 32768)) : Math.min(32767, Math.round(s * 32767)), true); p += 2; }
  return out;
}

const formats = FORMATS.map((f) => ({ id: f.id, label: f.label, extensions: f.extensions.slice(), console: f.console, headerless: f.headerless }));
const api = { version, encode, decode, detect, toWav, formats };

return api;
}));
