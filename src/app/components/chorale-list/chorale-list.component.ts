import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { Subject, of } from 'rxjs';
import { catchError, switchMap } from 'rxjs/operators';
import { CHORALE_FILES } from '../../data/chorales-list.generated';
import { MusicXmlParserService, ParsedChorale } from '../../services/music-xml-parser.service';
import { ChoraleLabelPipe } from '../../pipes/chorale-label.pipe';

@Component({
  selector: 'app-chorale-list',
  imports: [ FormsModule, ChoraleLabelPipe ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-body">
        <div class="mb-3">
          <div class="form-check form-check-inline">
            <input
              class="form-check-input"
              type="radio"
              id="source-list"
              name="source"
              [value]="false"
              [ngModel]="useCustomUrl()"
              (ngModelChange)="useCustomUrl.set($event)"
            />
            <label class="form-check-label" for="source-list">Choose from list</label>
          </div>
          <div class="form-check form-check-inline">
            <input
              class="form-check-input"
              type="radio"
              id="source-custom"
              name="source"
              [value]="true"
              [ngModel]="useCustomUrl()"
              (ngModelChange)="useCustomUrl.set($event)"
            />
            <label class="form-check-label" for="source-custom">Custom URL</label>
          </div>
        </div>

        <div class="input-group">
          @if (!useCustomUrl()) {
            <select
              id="chorale-select"
              class="form-select"
              [ngModel]="selectedFilename()"
              (ngModelChange)="selectedFilename.set($event)"
              aria-label="Select chorale"
            >
              @for (file of choraleFiles; track file) {
                <option [value]="file">{{ file | choraleLabel }}</option>
              }
            </select>
          } @else {
            <input
              id="custom-url"
              type="url"
              class="form-control"
              placeholder="https://…"
              [ngModel]="customUrl()"
              (ngModelChange)="customUrl.set($event)"
              aria-label="Custom MusicXML URL"
            />
          }
          <button
            class="btn btn-primary"
            (click)="load()"
            [disabled]="isLoading()"
            [attr.aria-busy]="isLoading()"
          >
            @if (isLoading()) {
              <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
              Loading…
            } @else {
              Load &amp; Parse
            }
          </button>
        </div>

        @if (error()) {
          <div class="alert alert-danger mt-3 mb-0" role="alert">{{ error() }}</div>
        }
      </div>
    </div>
  `,
})
export class ChoraleListComponent {
  private readonly http = inject(HttpClient);

  private readonly parser = inject(MusicXmlParserService);

  readonly choraleLoaded = output<ParsedChorale>();

  protected readonly choraleFiles = CHORALE_FILES;

  protected readonly selectedFilename = signal(CHORALE_FILES[0] ?? '');

  protected readonly customUrl = signal('');

  protected readonly useCustomUrl = signal(false);

  protected readonly isLoading = signal(false);

  protected readonly error = signal<string | null>(null);

  private readonly loadTrigger$ = new Subject<string>();

  constructor() {
    this.loadTrigger$
      .pipe(
        switchMap((url) => this.http.get(url, { responseType: 'text' }).pipe(
          catchError((e: unknown) => {
            let message: string;
            if (e instanceof HttpErrorResponse) {
              message = e.statusText || e.message;
            } else if (e instanceof Error) {
              message = e.message;
            } else {
              message = String(e);
            }
            this.error.set(`Failed to load chorale: ${message}`);
            this.isLoading.set(false);
            return of(null);
          }),
        ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((xml) => {
        if (xml === null) {
          return; 
        }
        try {
          this.choraleLoaded.emit(this.parser.parse(xml));
        } catch (e) {
          this.error.set(`Failed to parse chorale: ${String(e)}`);
        }
        this.isLoading.set(false);
      });
  }

  protected load(): void {
    const url = this.useCustomUrl()
      ? this.customUrl()
      : `assets/chorales/${this.selectedFilename()}`;

    if (!url) {
      return; 
    }

    this.isLoading.set(true);
    this.error.set(null);
    this.loadTrigger$.next(url);
  }
}
