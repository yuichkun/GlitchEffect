<script setup lang="ts">
// GlitchEffect — Suara effect plugin (= `suara create` scaffold)。
// SDK の createDawInput() で DAW(またはweb helper)の audio input を受け、 最小
// passthrough worklet を通して出力レベルを表示する hello-world。ここから自分の
// DSP を育てる (= saturation / filter / delay など)。
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { createDawInput, runtime, useTransport } from '@suara/sdk';
import SuaraHostPanel from '@suara/sdk/helper/SuaraHostPanel.vue';
// audio-thread DSP。vite が TS worklet を ES module に bundle し URL を返す。
// dev 中に src/worklets/ を編集すると window ごと reload される (vite.config 参照)。
import workletUrl from './worklets/dsp-worklet.ts?worker&url';

const transport = useTransport();
const started = ref(false);

// ---- segmented stereo level meter ---------------------------------------
const SEG = 24; // segments per channel
const MIN_DB = -54; // bottom of the scale
const MAX_DB = 0; // top of the scale = digital full scale
const PEAK_HOLD_FRAMES = 45; // ~0.75s the peak dot stays before it falls
const CLIP_HOLD_FRAMES = 90; // ~1.5s the CLIP latch stays lit
const ATTACK = 0.5; // bar rise smoothing — snappy
const RELEASE = 0.12; // bar fall smoothing — slow, meter ballistics
const PEAK_FALL = 0.04; // peak dot descent once its hold expires

// dB zone of each segment, from its position on the scale.
function zoneOf(i: number): 'blue' | 'amber' | 'red' {
  const db = MIN_DB + ((i + 1) / SEG) * (MAX_DB - MIN_DB);
  if (db >= -3) return 'red';
  if (db >= -12) return 'amber';
  return 'blue';
}
const segZones = Array.from({ length: SEG }, (_, i) => zoneOf(i));

// dB scale ticks, positioned along the strip (0% = MIN_DB, 100% = MAX_DB).
const TICKS = [
  { label: '−∞', left: 0 },
  ...[-48, -36, -24, -12, -6, 0].map((db) => ({
    label: String(db),
    left: ((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100,
  })),
];

interface ChannelView {
  lit: number; // count of lit segments
  peakIdx: number; // segment index holding the peak (-1 = none)
  db: number; // numeric readout (held peak), -Infinity = silence
  clip: boolean;
}
const L = reactive<ChannelView>({ lit: 0, peakIdx: -1, db: -Infinity, clip: false });
const R = reactive<ChannelView>({ lit: 0, peakIdx: -1, db: -Infinity, clip: false });

interface ChannelState {
  analyser: AnalyserNode;
  buf: Float32Array;
  levelDb: number; // smoothed bar level
  peakDb: number; // held peak
  hold: number; // remaining peak-hold frames
  clipHold: number; // remaining clip-latch frames
}

let animationId: number | null = null;
let channels: ChannelState[] = [];

function toDb(x: number): number {
  return x > 0 ? 20 * Math.log10(x) : -Infinity;
}
function dbToNorm(db: number): number {
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

function processChannel(st: ChannelState, view: ChannelView): void {
  st.analyser.getFloatTimeDomainData(st.buf);

  let sum = 0;
  let peak = 0;
  for (let i = 0; i < st.buf.length; i++) {
    const s = st.buf[i];
    sum += s * s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  const rmsDb = toDb(Math.sqrt(sum / st.buf.length));
  const peakDb = toDb(peak);

  // bar: fast attack, slow release
  const target = Number.isFinite(rmsDb) ? rmsDb : MIN_DB;
  st.levelDb += (target - st.levelDb) * (target > st.levelDb ? ATTACK : RELEASE);
  if (st.levelDb < MIN_DB) st.levelDb = MIN_DB;

  // floating peak with hold-then-fall
  const p = Number.isFinite(peakDb) ? peakDb : MIN_DB;
  if (p >= st.peakDb) {
    st.peakDb = p;
    st.hold = PEAK_HOLD_FRAMES;
  } else if (st.hold > 0) {
    st.hold--;
  } else {
    st.peakDb += (MIN_DB - st.peakDb) * PEAK_FALL;
  }

  // clip latch at digital full scale
  if (peak >= 0.997) st.clipHold = CLIP_HOLD_FRAMES;
  else if (st.clipHold > 0) st.clipHold--;

  view.lit = Math.round(dbToNorm(st.levelDb) * SEG);
  view.peakIdx =
    st.peakDb <= MIN_DB ? -1 : Math.min(SEG - 1, Math.round(dbToNorm(st.peakDb) * SEG) - 1);
  view.db = st.peakDb <= MIN_DB ? -Infinity : st.peakDb;
  view.clip = st.clipHold > 0;
}

function updateMeter(): void {
  if (channels[0]) processChannel(channels[0], L);
  if (channels[1]) processChannel(channels[1], R);
  animationId = requestAnimationFrame(updateMeter);
}

function fmtDb(db: number): string {
  return Number.isFinite(db) ? db.toFixed(1) : '−∞';
}

async function startAudio(): Promise<void> {
  if (started.value) return;
  const ctx = new AudioContext();
  await ctx.resume();
  await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, 'suara-dsp', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  });

  const stream = await createDawInput();
  const source = ctx.createMediaStreamSource(stream);
  source.connect(node);
  node.connect(ctx.destination);

  // tap the DSP output and split it into per-channel analysers for true L/R metering
  const splitter = ctx.createChannelSplitter(2);
  node.connect(splitter);
  channels = [0, 1].map((ch) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    splitter.connect(analyser, ch);
    return {
      analyser,
      buf: new Float32Array(analyser.fftSize),
      levelDb: MIN_DB,
      peakDb: MIN_DB,
      hold: 0,
      clipHold: 0,
    };
  });

  started.value = true;
  updateMeter();
}

onMounted(() => {
  if (runtime.isVst) void startAudio();
});
onUnmounted(() => {
  if (animationId !== null) cancelAnimationFrame(animationId);
});
</script>

<template>
  <main class="sp">
    <div class="rack">
      <header class="rack-head">
        <span class="brand">SUARA</span>
        <span class="status" :class="{ live: runtime.isVst }">
          <i class="led-dot" />
          <span class="status-txt">{{ runtime.kind }}</span>
        </span>
      </header>

      <hr class="rule" />

      <section class="id">
        <span class="id-no">01</span>
        <h1 class="id-name">GlitchEffect</h1>
        <span class="id-kind">EFFECT</span>
      </section>

      <section class="pods">
        <div class="pod">
          <span class="pod-label">TEMPO</span>
          <span class="pod-value">{{ Math.round(transport.state.tempo) }}<small>BPM</small></span>
        </div>
        <div class="pod">
          <span class="pod-label">TRANSPORT</span>
          <span class="pod-value" :class="{ active: transport.state.isPlaying }">{{
            transport.state.isPlaying ? 'PLAY' : 'STOP'
          }}</span>
        </div>
      </section>

      <section class="meter-rack">
        <div class="meter-head">
          <span class="meter-title">OUTPUT</span>
          <span class="meter-route">in → out · passthrough</span>
          <span class="clip" :class="{ on: L.clip || R.clip }">CLIP</span>
        </div>

        <div class="meter">
          <div class="meter-row">
            <span class="meter-ch">L</span>
            <div class="leds">
              <span
                v-for="i in SEG"
                :key="'l' + i"
                class="led"
                :class="[segZones[i - 1], { on: i - 1 < L.lit, peak: i - 1 === L.peakIdx }]"
              />
            </div>
            <span class="meter-val">{{ fmtDb(L.db) }}</span>
          </div>

          <div class="meter-row">
            <span class="meter-ch">R</span>
            <div class="leds">
              <span
                v-for="i in SEG"
                :key="'r' + i"
                class="led"
                :class="[segZones[i - 1], { on: i - 1 < R.lit, peak: i - 1 === R.peakIdx }]"
              />
            </div>
            <span class="meter-val">{{ fmtDb(R.db) }}</span>
          </div>

          <div class="meter-scale">
            <span v-for="t in TICKS" :key="t.label" class="tick" :style="{ left: t.left + '%' }">{{
              t.label
            }}</span>
          </div>
        </div>
      </section>

      <button v-if="!started" class="run" @click="startAudio">
        <i class="run-tri" /> START
      </button>
    </div>

    <!-- web runtime だけ出る DAW 代役 (= audio input 源 / transport)。VST では DAW が供給。 -->
    <SuaraHostPanel v-if="runtime.isWeb" />
  </main>
</template>

<style>
:root {
  /* Sonic Purity — DESIGN.md tokens */
  --surface: #fbfbfb;
  --surface-container-lowest: #ffffff;
  --surface-container-low: #f3f3f3;
  --surface-container: #eeeeee;
  --surface-container-high: #e8e8e8;
  --surface-container-highest: #e2e2e2;
  --on-surface: #1a1c1c;
  --on-surface-variant: #414755;
  --outline: #717786;
  --outline-variant: #c1c6d7;
  --primary: #0058bc;
  --primary-bright: #007aff;
  --on-primary: #ffffff;
  --primary-container: #0070eb;
  --primary-fixed: #d8e2ff;
  --primary-fixed-dim: #adc6ff;
  --on-primary-fixed-variant: #004493;
  --secondary: #5d5f5f;
  --tertiary: #c64f00;
  --error: #ba1a1a;
  --error-container: #ffdad6;

  /* neomorphic dual-tone shadow stops (DESIGN.md — Elevation & Depth) */
  --nm-light: #ffffff;
  --nm-shadow: #e3e4e6;
  --line: #e5e5e5;

  /* meter — unlit segment */
  --seg-off: #dfe2e7;

  /* aliases consumed by SuaraHostPanel / VirtualKeyboard */
  --accent: var(--primary);
  --fg: var(--on-surface);
  --muted: var(--secondary);

  color-scheme: light;
}

* {
  box-sizing: border-box;
}

html,
body {
  margin: 0;
  background: var(--surface);
}

body {
  font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  color: var(--on-surface);
  -webkit-font-smoothing: antialiased;
}
</style>

<style scoped>
.sp {
  min-height: 100vh;
  padding: 24px;
  display: flex;
  justify-content: center;
  align-items: flex-start;
}

.rack {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px;
  background: var(--surface);
  border: 1px solid var(--outline-variant);
  border-radius: 12px;
  box-shadow: inset 0 1px 0 var(--nm-light), 0 18px 44px -26px rgba(26, 28, 28, 0.3);
}

@media (min-width: 640px) {
  .rack {
    padding: 32px;
  }
}

/* header ---------------------------------------------------------------- */
.rack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.brand {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.24em;
  color: var(--on-surface);
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  border-radius: 4px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--secondary);
  background: var(--surface-container-low);
  box-shadow: inset 1px 1px 2px var(--nm-shadow), inset -1px -1px 2px var(--nm-light);
}

.led-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--outline);
}

.status.live {
  color: var(--on-primary-fixed-variant);
}

.status.live .led-dot {
  background: var(--primary-bright);
  box-shadow: 0 0 6px 1px rgba(0, 122, 255, 0.6);
}

.rule {
  height: 1px;
  margin: 0;
  border: 0;
  background: var(--line);
}

/* identity -------------------------------------------------------------- */
.id {
  display: flex;
  align-items: baseline;
  gap: 12px;
}

.id-no {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--primary);
}

.id-name {
  margin: 0;
  font-size: 32px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.1;
  color: var(--on-surface);
}

.id-kind {
  margin-left: auto;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--secondary);
}

/* readout pods ---------------------------------------------------------- */
.pods {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.pod {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px 16px;
  border-radius: 6px;
  background: var(--surface-container-low);
  box-shadow: inset 1.5px 1.5px 3px var(--nm-shadow), inset -1.5px -1.5px 3px var(--nm-light);
}

.pod-label {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--secondary);
}

.pod-value {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 20px;
  font-weight: 500;
  line-height: 1;
  color: var(--on-surface);
  font-variant-numeric: tabular-nums;
}

.pod-value small {
  margin-left: 4px;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--secondary);
}

.pod-value.active {
  color: var(--primary);
}

/* meter ----------------------------------------------------------------- */
.meter-rack {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
  border-radius: 8px;
  background: var(--surface-container-low);
  border: 1px solid var(--line);
}

.meter-head {
  display: flex;
  align-items: center;
  gap: 10px;
}

.meter-title {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: var(--on-surface);
}

.meter-route {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--secondary);
}

.clip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 3px 8px;
  border-radius: 4px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--outline-variant);
  background: var(--surface-container);
  box-shadow: inset 1px 1px 2px var(--nm-shadow), inset -1px -1px 2px var(--nm-light);
  transition: color 0.1s, background 0.1s, box-shadow 0.1s;
}

.clip::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--outline-variant);
}

.clip.on {
  color: #fff;
  background: var(--error);
  box-shadow: 0 0 9px rgba(186, 26, 26, 0.55);
}

.clip.on::before {
  background: #fff;
}

.meter {
  display: grid;
  grid-template-columns: 1.5ch 1fr 5.5ch;
  column-gap: 10px;
  row-gap: 8px;
  align-items: center;
}

.meter-row {
  display: contents;
}

.meter-ch {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  color: var(--secondary);
}

.leds {
  display: flex;
  gap: 2px;
  height: 16px;
  padding: 3px;
  border-radius: 3px;
  background: var(--surface-container-high);
  box-shadow: inset 1px 1px 2px var(--nm-shadow), inset -1px -1px 2px var(--nm-light);
}

.led {
  flex: 1;
  border-radius: 1px;
  background: var(--seg-off);
  transition: background 0.04s linear, box-shadow 0.04s linear;
}

.led.blue {
  --c: var(--primary);
  --g: 0, 88, 188;
}

.led.amber {
  --c: var(--tertiary);
  --g: 198, 79, 0;
}

.led.red {
  --c: var(--error);
  --g: 186, 26, 26;
}

.led.on {
  background: var(--c);
  box-shadow: 0 0 4px rgba(var(--g), 0.5);
}

.led.peak {
  background: var(--c);
  box-shadow: 0 0 7px rgba(var(--g), 0.85);
}

.meter-val {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  font-weight: 500;
  text-align: right;
  color: var(--on-surface-variant);
  font-variant-numeric: tabular-nums;
}

.meter-scale {
  grid-column: 2;
  position: relative;
  height: 14px;
  margin-top: 2px;
}

.tick {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 9px;
  color: var(--secondary);
  white-space: nowrap;
}

.tick::before {
  content: "";
  position: absolute;
  top: -3px;
  left: 50%;
  width: 1px;
  height: 3px;
  background: var(--outline-variant);
}

.meter-scale .tick:first-child {
  transform: translateX(0);
}

.meter-scale .tick:first-child::before {
  left: 0;
}

.meter-scale .tick:last-child {
  transform: translateX(-100%);
}

.meter-scale .tick:last-child::before {
  left: auto;
  right: 0;
}

/* run button ------------------------------------------------------------ */
.run {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 18px;
  border: none;
  border-radius: 4px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: var(--on-primary);
  background: var(--primary);
  cursor: pointer;
  box-shadow: -2px -2px 5px var(--nm-light), 2px 3px 6px rgba(0, 88, 188, 0.28);
  transition: transform 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;
}

.run:hover {
  background: var(--primary-container);
}

.run:active {
  transform: translateY(1px);
  box-shadow: inset 1px 1px 3px rgba(0, 40, 90, 0.4);
}

.run-tri {
  width: 0;
  height: 0;
  border-left: 6px solid currentColor;
  border-top: 4px solid transparent;
  border-bottom: 4px solid transparent;
}
</style>
