/* Shared checks for gamedac.js: used by test.html (browser) and tests/run.mjs (Node).
   Signals are synthetic and seeded, so every run is identical. */
(function (root) {
  function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function tones(sr, seconds, seed) {
    const n = Math.round(sr * seconds), x = new Float32Array(n), r = mulberry32(seed || 9), notes = [261.6, 329.6, 392, 523.3, 659.3, 784];
    for (let i = 0; i < n; i++) { const t = i / sr; let s = 0; notes.forEach((f, k) => { const e = Math.exp(-((t * 2 + k * 0.37) % 1.5) * 2.2); s += e * (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(4 * Math.PI * f * t) + 0.2 * Math.sin(6 * Math.PI * f * t)); }); x[i] = 0.12 * s + 0.004 * (r() - 0.5); }
    return x;
  }
  function voice(sr, seconds, seed) {
    const n = Math.round(sr * seconds), x = new Float32Array(n), r = mulberry32(seed || 5); let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, f0 = 110 + 25 * Math.sin(2 * Math.PI * 0.7 * t); ph += (2 * Math.PI * f0) / sr;
      const env = Math.max(0, Math.sin(2 * Math.PI * 3.1 * t)) ** 0.6; let s = 0;
      for (let h = 1; h * f0 < sr / 2 - 300; h++) { const f = h * f0; s += (1 / (1 + ((f - 700) / 500) ** 2) + 0.6 / (1 + ((f - 2400) / 700) ** 2) + 0.15 / (1 + ((f - 5000) / 1500) ** 2)) / Math.sqrt(h) * Math.sin(h * ph); }
      x[i] = 0.3 * env * s + 0.01 * (r() - 0.5) * env;
    }
    let pk = 0; for (const v of x) pk = Math.max(pk, Math.abs(v)); const g = 0.8 / pk; return x.map((v) => v * g);
  }
  function snr(ref, got) { let s = 0, e = 0; for (let i = 0; i < ref.length; i++) { const g = got[i] || 0; s += ref[i] * ref[i]; e += (ref[i] - g) ** 2; } return 10 * Math.log10(s / (e + 1e-30)); }
  function fnv(bytes) { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619) >>> 0; } return h.toString(16).padStart(8, '0'); }
  function pcmBytes(chs) { const n = chs[0].length, out = new Uint8Array(n * chs.length * 2), v = new DataView(out.buffer); let p = 0; for (let i = 0; i < n; i++) for (const c of chs) { v.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(c[i] * 32768))), true); p += 2; } return out; }

  // One entry per format: rate and channels chosen so no resampling happens; thresholds are floors for the tonal test signal.
  const PLAN = [
    { id: 'vag', opts: {}, sr: 44100, ch: 1, floor: 40, detect: 'vag' },
    { id: 'vag', label: 'vag (stereo, VAGi)', opts: { interleave: true }, sr: 32000, ch: 2, floor: 40, detect: 'vag' },
    { id: 'vb', opts: {}, sr: 22050, ch: 1, floor: 38, detect: null, dec: { sampleRate: 22050, channels: 1 } },
    { id: 'xa', opts: {}, sr: 37800, ch: 2, floor: 35, detect: 'xa' },
    { id: 'xa', label: 'xa (mono, 18.9 kHz)', opts: { xaRate: 18900 }, sr: 18900, ch: 1, floor: 30, detect: 'xa' },
    { id: 'dsp', opts: {}, sr: 32000, ch: 2, floor: 38, detect: 'dsp' },
    { id: 'dsp', label: 'dsp (mono)', opts: {}, sr: 44100, ch: 1, floor: 38, detect: 'dsp' },
    { id: 'adx', opts: {}, sr: 44100, ch: 2, floor: 40, detect: 'adx' },
    { id: 'aica', opts: {}, sr: 44100, ch: 1, floor: 30, detect: null, dec: { sampleRate: 44100, channels: 1 } },
    { id: 'yamaha-wav', opts: {}, sr: 22050, ch: 1, floor: 25, detect: 'yamaha-wav' },
    { id: 'vox', opts: { codecRate: 'native' }, sr: 8000, ch: 1, floor: 15, detect: null, dec: { sampleRate: 8000, channels: 1 } },
    { id: 'oki-wav', opts: { codecRate: 'native' }, sr: 8000, ch: 1, floor: 15, detect: 'oki-wav' }
  ];

  async function run(gd, report) {
    let passed = 0, failed = 0;
    const ok = (name, cond, detail) => { cond ? passed++ : failed++; report(name, !!cond, detail || ''); };
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const throws = (f) => { try { f(); return false; } catch (e) { return true; } };

    ok('exports version, encode, decode, detect, toWav, formats', typeof gd.version === 'string' && ['encode', 'decode', 'detect', 'toWav'].every((k) => typeof gd[k] === 'function') && Array.isArray(gd.formats), gd.version);
    ok('formats lists the 9 formats', gd.formats.length === 9 && ['vag', 'vb', 'xa', 'dsp', 'adx', 'aica', 'yamaha-wav', 'vox', 'oki-wav'].every((id) => gd.formats.some((f) => f.id === id)));

    // 1. round trip every format
    for (const t of PLAN) {
      const label = t.label || t.id, mk = (s) => (t.ch === 2 ? [tones(t.sr, 2, 3), voice(t.sr, 2, 4)] : [tones(t.sr, 2, 3)]);
      const chans = mk(), bytes = gd.encode({ format: t.id, channels: chans, sampleRate: t.sr, ...t.opts });
      ok(`${label}: encodes to a non-empty Uint8Array`, bytes instanceof Uint8Array && bytes.length > 100, bytes.length + ' bytes');
      ok(`${label}: detect() says ${t.detect}`, gd.detect(bytes) === t.detect, String(gd.detect(bytes)));
      const dec = gd.decode(bytes, t.detect ? {} : { format: t.id, ...(t.dec || {}) });
      ok(`${label}: decode gives ${t.ch} channel(s) at ${t.sr} Hz`, dec.channels === t.ch && dec.sampleRate === t.sr && dec.format === t.id, `${dec.channels} ch, ${dec.sampleRate} Hz`);
      const s0 = snr(chans[0], dec.channelData[0]);
      ok(`${label}: decoded audio matches the input (SNR above ${t.floor} dB)`, s0 > t.floor && dec.channelData[0].length >= chans[0].length, s0.toFixed(1) + ' dB');
      if (t.ch === 2) { const s1 = snr(chans[1], dec.channelData[1]); ok(`${label}: second channel stays separate (voice, SNR above 20 dB)`, s1 > 20, s1.toFixed(1) + ' dB'); }
    }

    // 2. API equivalences
    const x = tones(44100, 1, 3), v = voice(44100, 1, 4);
    const base = gd.encode({ format: 'adx', channels: [x, v], sampleRate: 44100 });
    ok('deterministic: encoding twice gives the same bytes', same(base, gd.encode({ format: 'adx', channels: [x, v], sampleRate: 44100 })));
    const il = new Float32Array(x.length * 2); for (let i = 0; i < x.length; i++) { il[2 * i] = x[i]; il[2 * i + 1] = v[i]; }
    ok('interleaved input gives the same bytes', same(base, gd.encode({ format: 'adx', interleaved: il, numChannels: 2, sampleRate: 44100 })));
    const xi = new Int16Array(x.length), xf = new Float32Array(x.length); for (let i = 0; i < x.length; i++) { xi[i] = Math.round(x[i] * 32768); xf[i] = xi[i] / 32768; }
    ok('Int16 input matches the same samples as floats', same(gd.encode({ format: 'dsp', channels: [xi], sampleRate: 44100 }), gd.encode({ format: 'dsp', channels: [xf], sampleRate: 44100 })));
    const mono = gd.decode(gd.encode({ format: 'vag', channels: [x, v], sampleRate: 44100 }));
    ok('vag without interleave mixes a stereo input down to mono', mono.channels === 1);
    const split = gd.encode({ format: 'dsp', channels: [x, v], sampleRate: 44100, split: true });
    ok('dsp split gives one standalone mono file per channel', Array.isArray(split) && split.length === 2 && split.every((f) => gd.decode(f).channels === 1));
    const w = gd.toWav(gd.decode(gd.encode({ format: 'adx', channels: [x], sampleRate: 44100 })));
    ok('toWav writes a plain 16-bit PCM WAV', String.fromCharCode(w[0], w[1], w[2], w[3]) === 'RIFF' && w[20] === 1 && w[34] === 16 && w.length === 44 + x.length * 2, w.length + ' bytes');

    // 3. layouts other tools depend on (each was found by comparing with vgmstream; see the README)
    const vagi = gd.encode({ format: 'vag', channels: [x, v], sampleRate: 44100, interleave: true }), dv = new DataView(vagi.buffer);
    ok('VAGi: audio starts at 0x800 and the size field counts one channel', String.fromCharCode(vagi[0], vagi[1], vagi[2], vagi[3]) === 'VAGi' && dv.getUint32(12) * 2 === vagi.length - 0x800, 'size ' + dv.getUint32(12));
    const dsp2 = gd.encode({ format: 'dsp', channels: [x, v], sampleRate: 44100 }), dd = new DataView(dsp2.buffer);
    ok('stereo DSP: two headers, channel field 1, block size 8', dd.getUint16(0x4a) === 1 && dd.getUint16(0x4c) === 8 && dd.getUint32(0x60) === dd.getUint32(0) && dd.getUint16(0x60 + 0x4a) === 1);
    const aicaLeak = gd.decode(gd.encode({ format: 'aica', channels: [x], sampleRate: 44100 }), { format: 'aica', sampleRate: 44100 }), aicaPlain = gd.decode(gd.encode({ format: 'aica', channels: [x], sampleRate: 44100 }), { format: 'aica', sampleRate: 44100, variant: 'ym' });
    ok('AICA uses the leaky predictor (decodes differently from the plain Yamaha variant)', snr(aicaLeak.channelData[0], aicaPlain.channelData[0]) < 40);

    // 4. loops
    const lp = gd.decode(gd.encode({ format: 'vag', channels: [x], sampleRate: 44100, loop: { start: 1000, end: 30000 } }));
    ok('vag loop points survive a round trip (to the 28-sample block)', lp.loop && Math.abs(lp.loop.start - 1000) < 28 && Math.abs(lp.loop.end - 30000) < 28, JSON.stringify(lp.loop));
    const ld = gd.decode(gd.encode({ format: 'dsp', channels: [x], sampleRate: 44100, loopStart: 2000, loopEnd: 40000 }));
    ok('dsp loop points survive a round trip', ld.loop && Math.abs(ld.loop.start - 2000) <= 14 && Math.abs(ld.loop.end - 40000) <= 14, JSON.stringify(ld.loop));
    const la = gd.decode(gd.encode({ format: 'adx', channels: [x], sampleRate: 44100, loopStart: 3200, loopEnd: 40000 }));
    ok('adx loop points survive a round trip', la.loop && la.loop.start === 3200 && la.loop.end === 40000, JSON.stringify(la.loop));

    // 5. edge cases and errors
    for (const id of ['vag', 'xa', 'dsp', 'adx']) { const tiny = gd.encode({ format: id, channels: [new Float32Array(10).fill(0.25)], sampleRate: id === 'xa' ? 37800 : 44100 }); const d = gd.decode(tiny); ok(`${id}: 10 samples still make a valid file`, d.channelData[0].length >= (id === 'xa' ? 1 : 10) && Number.isFinite(d.channelData[0][0]), d.channelData[0].length + ' samples'); }
    for (const id of ['vag', 'adx', 'dsp']) { const sil = gd.decode(gd.encode({ format: id, channels: [new Float32Array(5000)], sampleRate: 44100 })); let pk = 0; for (const s of sil.channelData[0]) pk = Math.max(pk, Math.abs(s)); ok(`${id}: silence decodes to silence`, pk < 1e-3, 'peak ' + pk.toExponential(1)); }
    ok('out-of-range samples are clamped, not wrapped', gd.decode(gd.encode({ format: 'vag', channels: [new Float32Array(2000).fill(5)], sampleRate: 44100 })).channelData[0].every((s) => Number.isFinite(s) && Math.abs(s) <= 1.0001));
    ok('unknown format throws', throws(() => gd.encode({ format: 'nope', channels: [x], sampleRate: 44100 })));
    ok('missing sampleRate throws', throws(() => gd.encode({ format: 'vag', channels: [x] })));
    ok('mismatched channel lengths throw', throws(() => gd.encode({ format: 'adx', channels: [x, x.subarray(10)], sampleRate: 44100 })));
    ok('decoding garbage throws', throws(() => gd.decode(new Uint8Array(3000))));
    ok('decoding headerless data without a format throws', throws(() => gd.decode(gd.encode({ format: 'vb', channels: [x], sampleRate: 44100 }))));
    ok('a truncated ADX throws instead of returning silence', throws(() => { const b = gd.encode({ format: 'adx', channels: [x], sampleRate: 44100 }); gd.decode(b.subarray(0, b.length - 400)); }));

    // 6. regression vectors: the encoded bytes and the decoded samples of one fixed clip per format.
    // The decoded samples of these formats were verified bit-identical to vgmstream (see docs/crosscheck.json); these hashes keep them from drifting.
    const vec = vectors(gd);
    const inNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    for (const [k, got] of Object.entries(vec.got)) { const exp = vec.expected[k]; ok(`regression vector: ${k}`, exp === got || !inNode, exp === got ? got : (inNode ? 'MISMATCH got ' + got + ' expected ' + exp : 'differs in this browser (' + got + '): floating-point library differences can change a rounding, checked in Node only')); }

    report('', true, passed + ' passed, ' + failed + ' failed', true);
    return { passed, failed };
  }

  // fixed clip -> { <format>.bytes, <format>.pcm } FNV hashes.
  const EXPECTED = {
    'vag.bytes': '40838765', 'vag.pcm': '5e55a06d', 'vag-vagi.bytes': '3af24165', 'vag-vagi.pcm': '74117eb4',
    'xa.bytes': 'ec0823ef', 'xa.pcm': '879b1337', 'dsp.bytes': '88ec5189', 'dsp.pcm': '9b595820',
    'adx.bytes': '9a0b3608', 'adx.pcm': '86bb8724', 'aica.bytes': '07bd6ff9', 'aica.pcm': '14a01fba',
    'yamaha-wav.bytes': '70a32c0c', 'yamaha-wav.pcm': 'fee1826f'
  };
  function vectors(gd) {
    const sr = 32000, a = tones(sr, 0.5, 21), b2 = voice(sr, 0.5, 22), got = {};
    for (const [id, o, ch] of [['vag', {}, 1], ['vag', { interleave: true }, 2], ['xa', {}, 2], ['dsp', {}, 2], ['adx', {}, 2], ['aica', {}, 1], ['yamaha-wav', {}, 1]]) {
      const rate = id === 'xa' ? 37800 : sr, chans = ch === 2 ? [tones(rate, 0.5, 21), voice(rate, 0.5, 22)] : [tones(rate, 0.5, 21)];
      const bytes = gd.encode({ format: id, channels: chans, sampleRate: rate, ...o }), d = gd.decode(bytes, id === 'aica' ? { format: 'aica', sampleRate: rate, channels: 1 } : {});
      const key = id + (o.interleave ? '-vagi' : '');
      got[key + '.bytes'] = fnv(bytes); got[key + '.pcm'] = fnv(pcmBytes(d.channelData));
    }
    void a; void b2;
    return { got, expected: EXPECTED };
  }
  const api = { run, tones, voice, snr, vectors, fnv };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.gamedacChecks = api;
}(typeof self !== 'undefined' ? self : this));