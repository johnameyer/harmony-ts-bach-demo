import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { MusicXmlParserService, ParsedChorale } from './services/music-xml-parser.service';

const BASE_URL =
  'https://raw.githubusercontent.com/juyaolongpaul/Bach_chorale_FB/master/FB_source/musicXML_master';

const AVAILABLE_CHORALES: { label: string; filename: string }[] = [
  { label: 'BWV 102.07 – Heut lebst du, heut bekehre dich', filename: 'BWV_102.07_FB.musicxml' },
  { label: 'BWV 104.06 – Du Hirte Israel, höre', filename: 'BWV_104.06_FB.musicxml' },
  { label: 'BWV 227.11 – Jesu, meine Freude', filename: 'BWV_227.11_FB.musicxml' },
  { label: 'BWV 253 – Ach Gott, erhör mein Seufzen', filename: 'BWV_253_FB.musicxml' },
  { label: 'BWV 9.07 – Es ist das Heil uns kommen her', filename: 'BWV_9.07_FB.musicxml' },
  { label: 'BWV 91.06 – Gelobet seist du, Jesu Christ', filename: 'BWV_91.06_FB.musicxml' },
  { label: 'BWV 93.07 – Wer nur den lieben Gott', filename: 'BWV_93.07_FB.musicxml' },
  { label: 'BWV 96.06 – Herr Christ, der einge Gottessohn', filename: 'BWV_96.06_FB.musicxml' },
];

@Component({
  selector: 'app-root',
  imports: [ FormsModule ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly http = inject(HttpClient);

  private readonly parser = inject(MusicXmlParserService);

  protected readonly chorales = AVAILABLE_CHORALES;

  protected readonly selectedFilename = signal(AVAILABLE_CHORALES[0].filename);

  protected readonly customUrl = signal('');

  protected readonly useCustomUrl = signal(false);

  protected readonly isLoading = signal(false);

  protected readonly error = signal<string | null>(null);

  protected readonly result = signal<ParsedChorale | null>(null);

  protected readonly displayBeats = signal(16);

  protected readonly visibleBeats = computed(
    () => this.result()?.beats.slice(0, this.displayBeats()) ?? [],
  );

  protected readonly hasMore = computed(() => {
    const r = this.result();
    return r !== null && r.beats.length > this.displayBeats();
  });

  protected load(): void {
    const url = this.useCustomUrl()
      ? this.customUrl()
      : `${BASE_URL}/${this.selectedFilename()}`;

    if (!url) {
      return; 
    }

    this.isLoading.set(true);
    this.error.set(null);
    this.result.set(null);
    this.displayBeats.set(16);

    this.http.get(url, { responseType: 'text' }).subscribe({
      next: (xml) => {
        try {
          const parsed = this.parser.parse(xml);
          this.result.set(parsed);
        } catch (e) {
          this.error.set(`Failed to parse chorale: ${String(e)}`);
        }
        this.isLoading.set(false);
      },
      error: (e: unknown) => {
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
      },
    });
  }

  protected showMore(): void {
    this.displayBeats.update((n) => n + 16);
  }
}

