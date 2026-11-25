// Phase 0 spike (P4 / C6): measure signalsmith-stretch timing in an OfflineAudioContext.
import SignalsmithStretch from '/node_modules/signalsmith-stretch/SignalsmithStretch.mjs';

const fs = 48000;
const CLICK_PERIOD = 0.5; // s
const INPUT_SEC = 12;
const RENDER_SEC = 9;

function makeClicks() {
  const n = INPUT_SEC * fs;
  const ch = new Float32Array(n);
  const burst = Math.round(0.01 * fs);
  for (let t = 0; t < INPUT_SEC; t += CLICK_PERIOD) {
    const s0 = Math.round(t * fs);
    for (let i = 0; i < burst && s0 + i < n; i++) {
      ch[s0 + i] = 0.8 * Math.sin((2 * Math.PI * 2000 * i) / fs) * Math.exp(-i / (0.003 * fs));
    }
  }
  return ch;
}

function envelope(x) {
  const out = new Float32Array(x.length);
  const a = Math.exp(-1 / (0.0005 * fs));
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Math.abs(x[i]);
    e = v > e ? v : a * e;
    out[i] = e;
  }
  return out;
}

// Find onset (50% of local max) inside [t-0.12, t+0.12] around each expected time.
function measure(rendered, expected) {
  const env = envelope(rendered);
  return expected.map((t) => {
    const lo = Math.max(0, Math.round((t - 0.12) * fs));
    const hi = Math.min(env.length, Math.round((t + 0.12) * fs));
    let max = 0;
    for (let i = lo; i < hi; i++) max = Math.max(max, env[i]);
    if (max < 0.02) return { expected: t, found: null };
    let on = lo;
    while (on < hi && env[on] < 0.5 * max) on++;
    return { expected: t, found: on / fs, errMs: (on / fs - t) * 1000 };
  });
}

// Map input time -> output time for piecewise-linear segments [{outputTime,input,rate}]
function inputToOutput(segs, tin) {
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i];
    if (tin >= s.input) return s.outputTime + (tin - s.input) / s.rate;
  }
  return null;
}

async function render(setup) {
  const ctx = new OfflineAudioContext(2, RENDER_SEC * fs, fs);
  const node = await SignalsmithStretch(ctx);
  node.connect(ctx.destination);
  const L = makeClicks();
  const R = L.slice();
  await node.addBuffers([L, R]);
  const latency = await node.latency();
  await setup(node);
  const buf = await ctx.startRendering();
  return { data: buf.getChannelData(0), latency };
}

function summarize(rows) {
  const errs = rows.filter((r) => r.found != null).map((r) => r.errMs);
  const mean = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
  const sd = Math.sqrt(errs.reduce((a, b) => a + (b - mean) ** 2, 0) / (errs.length || 1));
  return { n: rows.length, found: errs.length, meanErrMs: +mean.toFixed(2), sdErrMs: +sd.toFixed(2), maxAbsErrMs: +Math.max(...errs.map(Math.abs)).toFixed(2) };
}

async function main() {
  const result = {};

  // T1: constant rate 1 from outputTime 0.5
  {
    const segs = [{ outputTime: 0.5, input: 0, rate: 1 }];
    const { data, latency } = await render(async (n) => {
      await n.schedule({ active: true, ...segs[0] });
    });
    const exp = [];
    for (let tin = 0; tin < 8; tin += CLICK_PERIOD) exp.push(inputToOutput(segs, tin));
    result.latencySec = latency;
    result.T1_rate1 = summarize(measure(data, exp.filter((t) => t < RENDER_SEC - 0.2)));
  }

  // T2: piecewise via `outputTime` key (1 -> 1.08 -> 0.92)
  {
    const segs = [
      { outputTime: 0.5, input: 0, rate: 1 },
      { outputTime: 2.5, input: 2.0, rate: 1.08 },
      { outputTime: 4.5, input: 2.0 + 2 * 1.08, rate: 0.92 },
    ];
    const { data } = await render(async (n) => {
      for (const s of segs) await n.schedule({ active: true, ...s });
    });
    const exp = [];
    for (let tin = 0; tin < 10; tin += CLICK_PERIOD) exp.push(inputToOutput(segs, tin));
    const rows = measure(data, exp.filter((t) => t < RENDER_SEC - 0.2));
    result.T2_outputTime_piecewise = summarize(rows);
    result.T2_bySegment = {
      rate1: summarize(rows.filter((r) => r.expected < 2.5)),
      rate108: summarize(rows.filter((r) => r.expected >= 2.6 && r.expected < 4.5)),
      rate092: summarize(rows.filter((r) => r.expected >= 4.6)),
    };
  }

  // T3: README-style `output` key, two future segments. Does the first survive?
  {
    const { data } = await render(async (n) => {
      await n.schedule({ active: true, output: 0.5, input: 0, rate: 1 });
      await n.schedule({ active: true, output: 2.5, input: 2.0, rate: 1.08 });
    });
    const early = measure(data, [0.5, 1.0, 1.5, 2.0]);
    result.T3_outputKey_firstSegmentClicksFound = early.filter((r) => r.found != null).length + '/4';
  }

  console.log('RESULT ' + JSON.stringify(result));
}

main().catch((e) => console.log('RESULT ' + JSON.stringify({ error: String(e?.stack ?? e) })));
