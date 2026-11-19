// Every sound is synthesised. No audio files to download.

let ctx: AudioContext | null = null;
let master: GainNode;
let enabled = true;

// Minor pentatonic over two octaves: combos climb the scale.
const SCALE = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];
const hz = (semi: number, base = 392) => base * 2 ** (semi / 12);

export function setSound(on: boolean) {
  enabled = on;
}

/** Call from a user gesture: browsers only start audio after one. */
export function unlockAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return;
  }
  const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.32;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = 'sine', vol = 0.5, slideTo = 0) {
  if (!ctx || !enabled) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const sfx = {
  eat(combo: number) {
    const n = SCALE[Math.min(combo * 2, SCALE.length - 1)];
    tone(hz(n), 0, 0.14, 'triangle', 0.55);
    tone(hz(n + 12), 0.004, 0.09, 'sine', 0.18);
  },
  gold() {
    [0, 4, 7, 12].forEach((s, i) => tone(hz(s + 12), i * 0.05, 0.2, 'triangle', 0.4));
  },
  turn() {
    tone(1800, 0, 0.012, 'square', 0.03);
  },
  bite() {
    tone(220, 0, 0.12, 'sawtooth', 0.25, 110);
  },
  die() {
    tone(hz(-5), 0, 0.5, 'sawtooth', 0.28, hz(-29));
    tone(hz(-12), 0.02, 0.4, 'triangle', 0.35, hz(-36));
  },
  best() {
    [0, 7, 12, 16, 19].forEach((s, i) => tone(hz(s), 0.15 + i * 0.07, 0.4, 'triangle', 0.32));
  },
  tick(urgent: boolean) {
    tone(urgent ? 1320 : 990, 0, 0.04, 'sine', 0.2);
  },
  start() {
    tone(hz(0), 0, 0.08, 'triangle', 0.35);
    tone(hz(7), 0.06, 0.12, 'triangle', 0.35);
  },
};
