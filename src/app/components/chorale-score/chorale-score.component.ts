import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterEveryRender,
  computed,
  inject,
  input,
} from '@angular/core';
import {
  Accidental,
  AnnotationVerticalJustify,
  Factory,
  Note,
  Voice,
  VoiceMode,
} from 'vexflow';
import { ParsedChorale, ParsedMeasure, ParsedMeasureNote } from '../../services/music-xml-parser.service';

const FIFTHS_TO_KEY: Record<number, string> = {
  [-7]: 'Cb',
  [-6]: 'Gb',
  [-5]: 'Db',
  [-4]: 'Ab',
  [-3]: 'Eb',
  [-2]: 'Bb',
  [-1]: 'F',
  0: 'C',
  1: 'G',
  2: 'D',
  3: 'A',
  4: 'E',
  5: 'B',
  6: 'F#',
  7: 'C#',
};

const ACCIDENTAL_TO_VEX: Record<number, string> = {
  [-2]: 'bb',
  [-1]: 'b',
  0: '',
  1: '#',
  2: '##',
};

const MEASURES_PER_ROW = 4;
const SYSTEM_WIDTH = 960;
const SYSTEM_HEIGHT = 390;
/** Vertical offset of the VexFlow system within the SVG (leaves room for soprano top-annotations). */
const SYSTEM_Y_OFFSET = 40;
/** Horizontal offset; leaves room for brace/singleLeft connectors that extend left of the system. */
const SYSTEM_X_OFFSET = 20;

function noteToVexKey(noteEvent: ParsedMeasureNote, clef: 'treble' | 'bass'): string {
  if (!noteEvent.note) {
    return clef === 'treble' ? 'b/4' : 'd/3';
  }
  const acc = ACCIDENTAL_TO_VEX[noteEvent.note.accidental as number] ?? '';
  return `${noteEvent.note.letterName.toLowerCase()}${acc}/${noteEvent.note.octavePosition}`;
}

function createStaveNote(
  vf: Factory,
  n: ParsedMeasureNote,
  clef: 'treble' | 'bass',
  stemDirection: number,
  figurationsJustify: AnnotationVerticalJustify = AnnotationVerticalJustify.TOP,
  figurationsTextLine = 1,
): Note {
  const staveNote = vf.StaveNote({
    keys: [ noteToVexKey(n, clef) ],
    duration: n.note ? n.vexDuration : `${n.vexDuration}r`,
    stemDirection,
    clef,
  });
  if (n.figuration) {
    const ann = vf.Annotation({ text: n.figuration });
    ann.setVerticalJustification(figurationsJustify);
    ann.setTextLine(figurationsTextLine);
    staveNote.addModifier(ann, 0);
  }
  return staveNote;
}

@Component({
  selector: 'app-chorale-score',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chorale-score mt-2">
      @for (rowId of rowIds(); track rowId) {
        <div [id]="rowId"></div>
      }
    </div>
  `,
  styles: [ `
    .chorale-score { overflow-x: auto; }
    /* Allow VexFlow annotations that extend beyond the SVG bounds to remain visible */
    .chorale-score svg { overflow: visible; }
  ` ],
})
export class ChoraleScoreComponent {
  readonly chorale = input.required<ParsedChorale>();

  private readonly hostEl = inject(ElementRef);

  private renderedChorale: ParsedChorale | null = null;

  private readonly instanceId = `cs-${crypto.randomUUID()}`;

  protected readonly rowIds = computed(() => {
    const c = this.chorale();
    const rowCount = Math.ceil((c.measures.length || 1) / MEASURES_PER_ROW);
    return Array.from({ length: rowCount }, (_, i) => `${this.instanceId}-${i}`);
  });

  constructor() {
    afterEveryRender(() => {
      const current = this.chorale();
      if (current !== this.renderedChorale) {
        this.renderedChorale = current;
        this.renderScore(current);
      }
    });
  }

  private renderScore(chorale: ParsedChorale): void {
    const keyName = FIFTHS_TO_KEY[chorale.keyFifths] ?? 'C';
    const timeSig = `${chorale.timeBeats}/${chorale.timeBeatType}`;
    const rowCount = Math.ceil((chorale.measures.length || 1) / MEASURES_PER_ROW);

    for (let rowIdx = 0; rowIdx < rowCount; rowIdx++) {
      const rowId = `${this.instanceId}-${rowIdx}`;
      const rowEl = (this.hostEl.nativeElement as HTMLElement).querySelector(`#${rowId}`) as HTMLElement | null;
      if (!rowEl) {
        continue; 
      }

      rowEl.innerHTML = '';

      const startMeasure = rowIdx * MEASURES_PER_ROW;
      const endMeasure = Math.min(startMeasure + MEASURES_PER_ROW, chorale.measures.length);
      const rowMeasures = chorale.measures.slice(startMeasure, endMeasure);

      try {
        this.renderRow(rowEl, rowId, rowMeasures, keyName, timeSig, rowIdx === 0);
      } catch {
        // Skip rows that fail to render (e.g. no DOM context in SSR)
      }
    }
  }

  private renderRow(
    container: HTMLElement,
    containerId: string,
    measures: ParsedMeasure[],
    keyName: string,
    timeSig: string,
    isFirstRow: boolean,
  ): void {
    container.id = containerId;
    const vf = new Factory({
      renderer: { elementId: containerId, width: SYSTEM_WIDTH, height: SYSTEM_HEIGHT },
    });

    const system = vf.System({ x: SYSTEM_X_OFFSET, y: SYSTEM_Y_OFFSET, width: SYSTEM_WIDTH - SYSTEM_X_OFFSET * 2, autoWidth: false });

    const soprano: Note[] = [];
    const alto: Note[] = [];
    const tenor: Note[] = [];
    const bass: Note[] = [];

    measures.forEach((measure, mIdx) => {
      if (mIdx > 0) {
        soprano.push(vf.BarNote());
        alto.push(vf.BarNote());
        tenor.push(vf.BarNote());
        bass.push(vf.BarNote());
      }

      const sopranoNotes = measure.partNotes[0] ?? [];
      const altoNotes = measure.partNotes[1] ?? [];
      const tenorNotes = measure.partNotes[2] ?? [];
      const bassNotes = measure.partNotes[3] ?? [];
      const fb = measure.figuredBass;

      sopranoNotes.forEach((n) => {
        soprano.push(createStaveNote(vf, n, 'treble', 1));
      });

      altoNotes.forEach((n) => {
        alto.push(createStaveNote(vf, n, 'treble', -1, AnnotationVerticalJustify.BOTTOM));
      });

      tenorNotes.forEach((n) => {
        tenor.push(createStaveNote(vf, n, 'bass', 1));
      });

      bassNotes.forEach((n, noteIdx) => {
        const figures = fb[noteIdx] ?? [];
        // Figuration label goes below figured-bass annotations; offset by their count
        const bassNote = createStaveNote(vf, n, 'bass', -1, AnnotationVerticalJustify.BOTTOM, figures.length + 1);

        figures.forEach((fig, figIdx) => {
          const ann = vf.Annotation({ text: fig, vJustify: 'bottom' });
          ann.setVerticalJustification(AnnotationVerticalJustify.BOTTOM);
          ann.setTextLine(figIdx + 1);
          bassNote.addModifier(ann, 0);
        });

        bass.push(bassNote);
      });
    });

    const makeVoice = (notes: Note[]): Voice => vf.Voice(undefined).setMode(VoiceMode.SOFT)
      .addTickables(notes);

    const sopranoVoice = makeVoice(soprano);
    const altoVoice = makeVoice(alto);
    const tenorVoice = makeVoice(tenor);
    const bassVoice = makeVoice(bass);

    Accidental.applyAccidentals([ sopranoVoice, altoVoice ], keyName);
    Accidental.applyAccidentals([ tenorVoice, bassVoice ], keyName);

    const trebleStave = system.addStave({ voices: [ sopranoVoice, altoVoice ] });
    trebleStave.addClef('treble').addKeySignature(keyName);
    if (isFirstRow) {
      trebleStave.addTimeSignature(timeSig);
    }

    const bassStave = system.addStave({ voices: [ tenorVoice, bassVoice ] });
    bassStave.addClef('bass').addKeySignature(keyName);
    if (isFirstRow) {
      bassStave.addTimeSignature(timeSig);
    }

    system.addConnector('brace');
    system.addConnector('singleLeft');
    system.addConnector('singleRight');

    vf.draw();
  }
}
