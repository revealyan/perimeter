// Короткий сигнал окончания хода без аудиофайлов (WebAudio: две ноты).
// Режим «perimeter:turn-sound»: off — никогда · bg — окно не в фокусе · always — всегда.

let ctx: AudioContext | null = null;

export type TurnSoundMode = 'off' | 'bg' | 'always';

export function turnSoundMode(): TurnSoundMode {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem('perimeter:turn-sound') : null;
  return v === 'off' || v === 'always' ? v : 'bg';
}

/** Двойной «динь» (A5 → D6, ~0.25 с, тихо); сбой WebAudio — просто тишина. */
export function playTurnDone(): void {
  try {
    ctx ??= new AudioContext();
    const ac = ctx;
    if (ac.state === 'suspended') void ac.resume();
    const t0 = ac.currentTime;
    [880, 1174.66].forEach((freq, i) => {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      const at = t0 + i * 0.12;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.07, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
      o.connect(g).connect(ac.destination);
      o.start(at);
      o.stop(at + 0.12);
    });
  } catch { /* нет WebAudio — обойдёмся без звука */ }
}
