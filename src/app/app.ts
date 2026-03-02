import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ChoraleListComponent } from './components/chorale-list/chorale-list.component';
import { ChoraleViewerComponent } from './components/chorale-viewer/chorale-viewer.component';
import { ParsedChorale } from './services/music-xml-parser.service';

@Component({
  selector: 'app-root',
  imports: [ ChoraleListComponent, ChoraleViewerComponent ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container py-4">
      <h1 class="mb-1">Bach Chorale Parser</h1>
      <p class="text-muted mb-3">
        Load a Bach chorale from the
        <a href="https://github.com/juyaolongpaul/Bach_chorale_FB" target="_blank" rel="noopener noreferrer"
          >Bach_chorale_FB</a
        >
        MusicXML dataset and parse it into beat-indexed
        <a href="https://github.com/johnameyer/harmony-ts" target="_blank" rel="noopener noreferrer"
          >harmony-ts</a
        >
        note arrays.
      </p>

      <app-chorale-list (choraleLoaded)="result.set($event)" />

      @if (result(); as r) {
        <app-chorale-viewer [chorale]="r" />
      }
    </div>
  `,
})
export class App {
  protected readonly result = signal<ParsedChorale | null>(null);
}

