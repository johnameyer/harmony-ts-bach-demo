import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { ParsedChorale } from '../../services/music-xml-parser.service';
import { ChoraleScoreComponent } from '../chorale-score/chorale-score.component';

const PAGE_SIZE = 16;

@Component({
  selector: 'app-chorale-viewer',
  imports: [ ChoraleScoreComponent ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card mt-3">
      <div class="card-header">
        <h2 class="h5 mb-0">{{ chorale().title }}</h2>
        <small class="text-muted">
          {{ chorale().beats.length }} quarter-note beats
          &middot; {{ chorale().partNames.length }} parts
        </small>
      </div>
      <div class="card-body p-2">
        <app-chorale-score [chorale]="chorale()" />
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
                  <tr>
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

  protected readonly displayBeats = signal(PAGE_SIZE);

  protected readonly visibleBeats = computed(
    () => this.chorale().beats.slice(0, this.displayBeats()),
  );

  protected readonly hasMore = computed(
    () => this.chorale().beats.length > this.displayBeats(),
  );

  protected showMore(): void {
    this.displayBeats.update((n) => n + PAGE_SIZE);
  }
}
