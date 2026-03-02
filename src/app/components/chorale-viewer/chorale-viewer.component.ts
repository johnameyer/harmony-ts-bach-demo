import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { ParsedChorale } from '../../services/music-xml-parser.service';
import { ChoraleScoreComponent } from '../chorale-score/chorale-score.component';
import { PlayerService } from '../../services/player.service';

const PAGE_SIZE = 16;

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
          <div class="d-flex align-items-center gap-2 flex-shrink-0">
            @if (!isPlaying()) {
              <button
                class="btn btn-sm btn-success"
                (click)="play()"
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

  private readonly player = inject(PlayerService);

  /** Unique id for the tempo range input (for accessibility label binding). */
  protected readonly tempoInputId = `tempo-${crypto.randomUUID()}`;

  protected readonly isPlaying = signal(false);

  protected readonly currentBeat = signal<number | null>(null);

  protected readonly tempo = signal(100);

  protected readonly displayBeats = signal(PAGE_SIZE);

  protected readonly visibleBeats = computed(
    () => this.chorale().beats.slice(0, this.displayBeats()),
  );

  protected readonly hasMore = computed(
    () => this.chorale().beats.length > this.displayBeats(),
  );

  constructor() {
    // Stop playback and reset beat when the chorale changes
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
    this.isPlaying.set(true);
    this.player.play(
      chorale.beats,
      this.tempo(),
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
