/** Звук заглушка — Web Audio beep для win/big win (T-057) */

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (!ctx) ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    return ctx;
  } catch {
    return null;
  }
}

export function beep(frequency = 440, durationMs = 150, volume = 0.2): void {
  const c = getCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = frequency;
  gain.gain.value = volume;
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start();
  setTimeout(() => {
    gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.05);
    setTimeout(() => osc.stop(), 100);
  }, durationMs);
}

export function soundWin(multiple: number): void {
  if (multiple >= 100) {
    // mega win — арпеджио
    beep(523, 120, 0.3);
    setTimeout(() => beep(659, 120, 0.3), 120);
    setTimeout(() => beep(784, 200, 0.4), 240);
  } else if (multiple >= 20) {
    beep(660, 200, 0.3);
  } else if (multiple >= 2) {
    beep(440, 120, 0.2);
  }
}

export function soundSpin(): void {
  beep(180, 60, 0.1);
}
