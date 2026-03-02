import { Injectable, OnDestroy } from '@angular/core';
import { AbsoluteNote } from 'harmony-ts';

@Injectable({ providedIn: 'root' })
export class PlayerService implements OnDestroy {
  private audioCtx: AudioContext | null = null;

  private masterGain: GainNode | null = null;

  private scheduledTimeouts: ReturnType<typeof setTimeout>[] = [];

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

  play(
    beats: AbsoluteNote[][][],
    tempo: number,
    onBeat: (beat: number) => void,
    onStop: () => void,
  ): void {
    this.stop();
    const ctx = this.getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const msPerBeat = (60 / tempo) * 1000;
    const secPerBeat = 60 / tempo;
    const audioStartTime = ctx.currentTime + 0.05;

    for (let beatIdx = 0; beatIdx < beats.length; beatIdx++) {
      const beat = beats[beatIdx];
      const prevBeat = beatIdx > 0 ? beats[beatIdx - 1] : null;
      const audioTime = audioStartTime + beatIdx * secPerBeat;

      // Play notes that are NEW at this beat (not present in the previous beat of the same part)
      for (let partIdx = 0; partIdx < beat.length; partIdx++) {
        const partNotes = beat[partIdx];
        const prevPartNotes = prevBeat?.[partIdx] ?? [];
        for (const note of partNotes) {
          const isNew = !prevPartNotes.some((p) => p.midi === note.midi);
          if (isNew) {
            this.scheduleNote(ctx, note.midi, audioTime, secPerBeat * 1.8);
          }
        }
      }

      // Schedule beat-position callback
      const t = setTimeout(() => onBeat(beatIdx), beatIdx * msPerBeat + 50);
      this.scheduledTimeouts.push(t);
    }

    // Schedule the stop callback after the last beat
    const stopT = setTimeout(() => onStop(), beats.length * msPerBeat + 50);
    this.scheduledTimeouts.push(stopT);
  }

  private scheduleNote(
    ctx: AudioContext,
    midi: number,
    startTime: number,
    duration: number,
  ): void {
    if (!this.masterGain) {
      return;
    }
    const freq = this.midiToHz(midi);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const envGain = ctx.createGain();
    envGain.gain.setValueAtTime(0, startTime);
    envGain.gain.linearRampToValueAtTime(0.12, startTime + 0.02);
    envGain.gain.exponentialRampToValueAtTime(
      0.001,
      startTime + Math.max(duration - 0.05, 0.1),
    );

    osc.connect(envGain);
    envGain.connect(this.masterGain);

    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  stop(): void {
    for (const t of this.scheduledTimeouts) {
      clearTimeout(t);
    }
    this.scheduledTimeouts = [];
  }

  ngOnDestroy(): void {
    this.stop();
    // Ignore the close() promise – we don't need to handle its rejection
    void this.audioCtx?.close();
  }
}
