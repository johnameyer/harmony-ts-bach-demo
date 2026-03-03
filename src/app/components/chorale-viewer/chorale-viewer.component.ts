import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ParsedChorale } from '../../services/music-xml-parser.service';
import { ChoraleScoreComponent } from '../chorale-score/chorale-score.component';
import { Instrument, PlayerService, TimedNoteEvent } from '../../services/player.service';

const PAGE_SIZE = 16;

/** Map a VexFlow duration string (e.g. "q", "hd", "8") to quarter-note beats. */
function vexDurationToBeats(vexDuration: string): number {
  const dotless = vexDuration.replace(/d+$/, '');
  const dots = (vexDuration.match(/d+$/) ?? [ '' ])[0].length;
  const BASE_BEATS: Record<string, number> = {
    w: 4, h: 2, q: 1, 8: 0.5, 16: 0.25, 32: 0.125, 64: 0.0625,
  };
  const baseBeats = BASE_BEATS[dotless] ?? 1;
  let beats = baseBeats;
  let extra = baseBeats / 2;
  for (let i = 0; i < dots; i++) {
    beats += extra;
    extra /= 2;
  }
  return beats;
}

/** Build a flat list of note-onset events with fractional beat positions from a ParsedChorale. */
function computeTimedNoteEvents(chorale: ParsedChorale): TimedNoteEvent[] {
  const events: TimedNoteEvent[] = [];
  let beatOffset = 0;

  for (const measure of chorale.measures) {
    // Compute per-part events within the measure.
    for (let partIdx = 0; partIdx < 4; partIdx++) {
      let partBeat = beatOffset;
      for (const n of (measure.partNotes[partIdx] ?? [])) {
        const d = vexDurationToBeats(n.vexDuration);
        if (n.note) {
          events.push({ midi: n.note.midi, beatStart: partBeat, beatDuration: d });
        }
        partBeat += d;
      }
    }
    // Advance beat offset using soprano (part 0) measure duration.
    for (const n of (measure.partNotes[0] ?? [])) {
      beatOffset += vexDurationToBeats(n.vexDuration);
    }
  }
  return events;
}

@Component({
  selector: 'app-chorale-viewer',
  imports: [ ChoraleScoreComponent ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card mt-3">
      <div class="card-header">
        <div class="d-flex flex-wrap align-items-start gap-2">
          <div class="flex-grow-1">
            <h2 class="h5 mb-0">{{ chorale().title }}</h2>
            <small class="text-muted">
              {{ chorale().beats.length }} quarter-note beats
              &middot; {{ chorale().partNames.length }} parts
            </small>
          </div>
          <div class="d-flex align-items-center gap-2 flex-shrink-0 flex-wrap">
            @if (!isPlaying()) {
              <button
                class="btn btn-sm btn-success"
                (click)="play()"
                [disabled]="instrument() === 'piano' && !player.pianoReady()"
                aria-label="Play chorale"
              >
                ▶ Play
              </button>
            } @else {
              <button
                class="btn btn-sm btn-secondary"
                (click)="stop()"
                aria-label="Stop playback"
              >
                ■ Stop
              </button>
            }
            <label class="text-muted small mb-0" [for]="tempoInputId">♩ = {{ tempo() }}</label>
            <input
              type="range"
              class="form-range"
              style="width: 100px"
              [id]="tempoInputId"
              [disabled]="isPlaying()"
              min="40"
              max="200"
              step="1"
              [value]="tempo()"
              (input)="onTempoChange($event)"
              aria-label="Tempo in beats per minute"
            />
            <div class="d-flex align-items-center gap-1">
              <button
                class="btn btn-sm"
                [class.btn-outline-secondary]="instrument() !== 'oscillator'"
                [class.btn-primary]="instrument() === 'oscillator'"
                (click)="setInstrument('oscillator')"
                [disabled]="isPlaying()"
                aria-label="Use oscillator (triangle)"
                title="Oscillator"
              >
                ∿
              </button>
              <button
                class="btn btn-sm"
                [class.btn-outline-secondary]="instrument() !== 'piano'"
                [class.btn-primary]="instrument() === 'piano'"
                (click)="setInstrument('piano')"
                [disabled]="isPlaying()"
                [attr.aria-busy]="player.pianoLoading()"
                aria-label="Use piano samples"
                title="Piano"
              >
                @if (player.pianoLoading()) {
                  <span class="spinner-border spinner-border-sm" aria-hidden="true"></span>
                } @else {
                  🎹
                }
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="card-body p-2">
        <app-chorale-score [chorale]="chorale()" [currentBeat]="currentBeat()" />
      </div>
      <div class="card-footer">
        <details>
          <summary class="text-muted small" style="cursor:pointer">Show raw beat table</summary>
          <div class="table-responsive mt-2">
            <table class="table table-sm table-hover table-bordered mb-0" aria-label="Beat-indexed note array">
              <thead class="table-light">
                <tr>
                  <th scope="col" class="text-center">#</th>
                  @for (name of chorale().partNames; track $index) {
                    <th scope="col">{{ name }}</th>
                  }
                </tr>
              </thead>
              <tbody class="font-monospace">
                @for (beat of visibleBeats(); track $index) {
                  <tr [class.table-primary]="currentBeat() === $index">
                    <th scope="row" class="text-center text-muted">{{ $index + 1 }}</th>
                    @for (partNotes of beat; track $index) {
                      <td>
                        @if (partNotes.length === 0) {
                          <span class="text-muted" aria-label="rest">—</span>
                        } @else {
                          @for (note of partNotes; track $index) {
                            @if ($index > 0) {
                              <span class="text-muted">, </span>
                            }
                            {{ note.name }}
                          }
                        }
                      </td>
                    }
                  </tr>
                }
              </tbody>
            </table>
          </div>
          @if (hasMore()) {
            <div class="text-center mt-2">
              <button class="btn btn-sm btn-outline-secondary" (click)="showMore()">
                Show more ({{ displayBeats() }} of {{ chorale().beats.length }} beats shown)
              </button>
            </div>
          }
        </details>
      </div>
    </div>
  `,
})
export class ChoraleViewerComponent {
  readonly chorale = input.required<ParsedChorale>();

  readonly player = inject(PlayerService);

  /** Unique id for the tempo range input (for accessibility label binding). */
  protected readonly tempoInputId = `tempo-${crypto.randomUUID()}`;

  protected readonly isPlaying = signal(false);

  protected readonly currentBeat = signal<number | null>(null);

  protected readonly tempo = signal(80);

  protected readonly instrument = signal<Instrument>('piano');

  protected readonly displayBeats = signal(PAGE_SIZE);

  protected readonly visibleBeats = computed(
    () => this.chorale().beats.slice(0, this.displayBeats()),
  );

  protected readonly hasMore = computed(
    () => this.chorale().beats.length > this.displayBeats(),
  );

  constructor() {
    // Pre-load piano samples so they're ready when the user hits Play.
    if (!this.player.pianoReady() && !this.player.pianoLoading()) {
      this.player.loadPiano();
    }

    // Stop playback and reset beat when the chorale changes.
    effect(() => {
      this.chorale();
      untracked(() => {
        if (this.isPlaying()) {
          this.stop();
        }
      });
    });
  }

  protected play(): void {
    const chorale = this.chorale();
    const events = computeTimedNoteEvents(chorale);
    this.isPlaying.set(true);
    this.player.play(
      events,
      chorale.beats.length,
      this.tempo(),
      this.instrument(),
      (beat) => this.currentBeat.set(beat),
      () => {
        this.isPlaying.set(false);
        this.currentBeat.set(null);
      },
    );
  }

  protected stop(): void {
    this.player.stop();
    this.isPlaying.set(false);
    this.currentBeat.set(null);
  }

  protected setInstrument(value: Instrument): void {
    this.instrument.set(value);
    if (value === 'piano' && !this.player.pianoReady() && !this.player.pianoLoading()) {
      this.player.loadPiano();
    }
  }

  protected onTempoChange(event: Event): void {
    const value = (event.target as HTMLInputElement).valueAsNumber;
    if (Number.isFinite(value)) {
      this.tempo.set(value);
    }
  }

  protected showMore(): void {
    this.displayBeats.update((n) => n + PAGE_SIZE);
  }
}
