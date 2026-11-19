// Keyboard, swipe and gamepad, all turned into the same two signals: a direction or an action.

export type Action = 'confirm' | 'back' | 'pause';
export interface InputSink {
  dir(d: number): void;
  action(a: Action): void;
  anyGesture(): void;
}

const KEYS: Record<string, number> = {
  ArrowUp: 0, KeyW: 0, KeyK: 0,
  ArrowRight: 1, KeyD: 1, KeyL: 1,
  ArrowDown: 2, KeyS: 2, KeyJ: 2,
  ArrowLeft: 3, KeyA: 3, KeyH: 3,
};

export function bindInput(surface: HTMLElement, sink: InputSink, isPlaying: () => boolean) {
  addEventListener('keydown', (e) => {
    sink.anyGesture();
    const t = e.target as HTMLElement;
    if (t.closest('input, dialog')) return; // typing a name or using a dialog
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const d = KEYS[e.code];
    if (d !== undefined && isPlaying()) {
      e.preventDefault();
      if (!e.repeat) sink.dir(d);
      return;
    }
    if (e.repeat) return;
    if (e.code === 'Escape') sink.action('back');
    else if (e.code === 'KeyP' || (e.code === 'Space' && isPlaying())) {
      e.preventDefault();
      sink.action('pause');
    } else if ((e.code === 'Enter' || e.code === 'Space' || e.code === 'KeyR') && !t.closest('button, a')) {
      e.preventDefault();
      sink.action('confirm');
    }
  });

  // Swipe: commit a turn as soon as the finger has travelled far enough, then re-anchor,
  // so one continuous gesture can make several turns.
  let ax = 0;
  let ay = 0;
  let id = -1;
  let moved = false;
  const threshold = () => Math.max(14, Math.min(innerWidth, innerHeight) * 0.035);
  surface.addEventListener('pointerdown', (e) => {
    sink.anyGesture();
    if (e.pointerType === 'mouse' || !isPlaying()) return;
    id = e.pointerId;
    ax = e.clientX;
    ay = e.clientY;
    moved = false;
  });
  surface.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - ax;
    const dy = e.clientY - ay;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < threshold()) return;
    sink.dir(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : dy > 0 ? 2 : 0);
    ax = e.clientX;
    ay = e.clientY;
    moved = true;
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = -1;
    if (!moved && isPlaying()) sink.action('confirm'); // a tap starts the run
  };
  surface.addEventListener('pointerup', end);
  surface.addEventListener('pointercancel', () => (id = -1));
}

// Gamepad: polled once per frame, edge-triggered.
const prev: boolean[] = [];
export function pollGamepad(sink: InputSink) {
  const pads = navigator.getGamepads?.();
  if (!pads) return;
  for (const p of pads) {
    if (!p) continue;
    const ax = p.axes[0] ?? 0;
    const ay = p.axes[1] ?? 0;
    const now = [
      p.buttons[12]?.pressed || ay < -0.6,
      p.buttons[15]?.pressed || ax > 0.6,
      p.buttons[13]?.pressed || ay > 0.6,
      p.buttons[14]?.pressed || ax < -0.6,
      p.buttons[0]?.pressed,
      p.buttons[1]?.pressed,
      p.buttons[9]?.pressed,
    ].map(Boolean);
    now.forEach((down, i) => {
      if (down && !prev[i]) {
        sink.anyGesture();
        if (i < 4) sink.dir(i);
        else sink.action(i === 4 ? 'confirm' : i === 5 ? 'back' : 'pause');
      }
      prev[i] = down;
    });
    return; // first connected pad only
  }
}
