import { Injectable, OnDestroy, signal } from '@angular/core';

/** A single note onset with fractional quarter-beat timing. */
export interface TimedNoteEvent {
  /** MIDI note number (0–127). */
  midi: number;
  /** Start position in fractional quarter-note beats (e.g. 1.5 for the second eighth of beat 2). */
  beatStart: number;
  /** Duration in fractional quarter-note beats. */
  beatDuration: number;
}

export type Instrument = 'oscillator' | 'piano';

/** Salamander Grand Piano sample keys served from the Tone.js CDN. */
const SALAMANDER_URLS: Record<string, string> = {
  A0: 'A0.mp3', C1: 'C1.mp3', 'D#1': 'Ds1.mp3', 'F#1': 'Fs1.mp3',
  A1: 'A1.mp3', C2: 'C2.mp3', 'D#2': 'Ds2.mp3', 'F#2': 'Fs2.mp3',
  A2: 'A2.mp3', C3: 'C3.mp3', 'D#3': 'Ds3.mp3', 'F#3': 'Fs3.mp3',
  A3: 'A3.mp3', C4: 'C4.mp3', 'D#4': 'Ds4.mp3', 'F#4': 'Fs4.mp3',
  A4: 'A4.mp3', C5: 'C5.mp3', 'D#5': 'Ds5.mp3', 'F#5': 'Fs5.mp3',
  A5: 'A5.mp3', C6: 'C6.mp3', 'D#6': 'Ds6.mp3', 'F#6': 'Fs6.mp3',
  A6: 'A6.mp3', C7: 'C7.mp3', 'D#7': 'Ds7.mp3', 'F#7': 'Fs7.mp3',
  A7: 'A7.mp3', C8: 'C8.mp3',
};
const SALAMANDER_BASE_URL = 'https://tonejs.github.io/audio/salamander/';

const NOTE_NAMES = [ 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B' ];

@Injectable({ providedIn: 'root' })
export class PlayerService implements OnDestroy {
  /** Emits true while the piano samples are being downloaded. */
  readonly pianoLoading = signal(false);

  /** Emits true once the piano sampler is ready to use. */
  readonly pianoReady = signal(false);

  // --- Oscillator path (Web Audio API) ---
  private audioCtx: AudioContext | null = null;

  private masterGain: GainNode | null = null;

  // --- Piano path (Tone.js Sampler) ---
  private pianoSampler: import('tone').Sampler | null = null;

  private pianoLoadPromise: Promise<void> | null = null;

  // --- Scheduling state ---
  private scheduledTimeouts: ReturnType<typeof setTimeout>[] = [];

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Start loading the Salamander piano samples from the CDN.
   * Safe to call multiple times – loads only once.
   */
  loadPiano(): void {
    if (this.pianoLoadPromise) {
      return;
    }
    this.pianoLoading.set(true);
    this.pianoLoadPromise = import('tone').then(async (Tone) => {
      await Tone.start();
      this.pianoSampler = new Tone.Sampler({
        urls: SALAMANDER_URLS,
        baseUrl: SALAMANDER_BASE_URL,
        onload: () => {
          this.pianoLoading.set(false);
          this.pianoReady.set(true);
        },
      }).toDestination();
    });
  }

  /**
   * Schedule and play a chorale.
   *
   * @param events     Per-note timed events (fractional quarter-beat positions).
   * @param totalBeats Total number of integer quarter-note beats in the piece.
   * @param tempo      Quarter-notes per minute.
   * @param instrument Oscillator (instant) or piano (requires prior loadPiano()).
   * @param onBeat     Fired at each integer beat index as playback progresses.
   * @param onStop     Fired when playback finishes.
   */
  play(
    events: TimedNoteEvent[],
    totalBeats: number,
    tempo: number,
    instrument: Instrument,
    onBeat: (beat: number) => void,
    onStop: () => void,
  ): void {
    this.stop();
    const secPerBeat = 60 / tempo;
    const msPerBeat = secPerBeat * 1000;

    if (instrument === 'piano' && this.pianoReady()) {
      this.schedulePiano(events, totalBeats, secPerBeat, msPerBeat, onBeat, onStop);
    } else {
      this.scheduleOscillator(events, totalBeats, secPerBeat, msPerBeat, onBeat, onStop);
    }
  }

  stop(): void {
    for (const t of this.scheduledTimeouts) {
      clearTimeout(t);
    }
    this.scheduledTimeouts = [];
  }

  ngOnDestroy(): void {
    this.stop();
    void this.audioCtx?.close();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private getAudioContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = 0.35;
      this.masterGain.connect(this.audioCtx.destination);
    }
    return this.audioCtx;
  }

  private midiToHz(midi: number): number {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  private midiToNoteName(midi: number): string {
    const octave = Math.floor(midi / 12) - 1;
    return `${NOTE_NAMES[midi % 12]}${octave}`;
  }

  private scheduleOscillator(
    events: TimedNoteEvent[],
    totalBeats: number,
    secPerBeat: number,
    msPerBeat: number,
    onBeat: (beat: number) => void,
    onStop: () => void,
  ): void {
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const audioStartTime = ctx.currentTime + 0.05;

    for (const event of events) {
      const audioTime = audioStartTime + event.beatStart * secPerBeat;
      const durationSec = Math.max(event.beatDuration * secPerBeat * 1.05, 0.08);
      this.scheduleOscNote(ctx, event.midi, audioTime, durationSec);
    }

    this.scheduleBeatCallbacks(totalBeats, msPerBeat, onBeat, onStop);
  }

  private scheduleOscNote(
    ctx: AudioContext,
    midi: number,
    startTime: number,
    duration: number,
  ): void {
    if (!this.masterGain) {
      return;
    }
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = this.midiToHz(midi);

    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0, startTime);
    envGain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
    envGain.gain.exponentialRampToValueAtTime(0.001, startTime + Math.max(duration - 0.05, 0.1));

    osc.connect(envGain);
    envGain.connect(this.masterGain);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  private schedulePiano(
    events: TimedNoteEvent[],
    totalBeats: number,
    secPerBeat: number,
    msPerBeat: number,
    onBeat: (beat: number) => void,
    onStop: () => void,
  ): void {
    // Schedule beat-callbacks only after Tone.js resolves so that
    // `audioStartTime` and the beat-timer origin are consistent.
    import('tone').then((Tone) => {
      const audioStartTime = Tone.getContext().currentTime + 0.05;
      for (const event of events) {
        const audioTime = audioStartTime + event.beatStart * secPerBeat;
        const durationSec = Math.max(event.beatDuration * secPerBeat * 1.05, 0.08);
        this.pianoSampler!.triggerAttackRelease(
          this.midiToNoteName(event.midi),
          durationSec,
          audioTime,
        );
      }
      this.scheduleBeatCallbacks(totalBeats, msPerBeat, onBeat, onStop);
    });
  }

  private scheduleBeatCallbacks(
    totalBeats: number,
    msPerBeat: number,
    onBeat: (beat: number) => void,
    onStop: () => void,
  ): void {
    for (let b = 0; b < totalBeats; b++) {
      const t = setTimeout(() => onBeat(b), b * msPerBeat + 50);
      this.scheduledTimeouts.push(t);
    }
    const stopT = setTimeout(() => onStop(), totalBeats * msPerBeat + 50);
    this.scheduledTimeouts.push(stopT);
  }
}
