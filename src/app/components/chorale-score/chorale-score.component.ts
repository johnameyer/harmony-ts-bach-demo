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
  TextNote,
  Voice,
  VoiceMode,
} from 'vexflow';
import { ParsedChorale, ParsedMeasure, ParsedMeasureNote } from '../../services/music-xml-parser.service';

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
/** VexFlow staff line at which roman-numeral TextNotes are rendered (below the bass staff). */
const ROMAN_NUMERAL_LINE = 12;

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

  /** Beat index (0-based quarter-note beats) to highlight, or null for none. */
  readonly currentBeat = input<number | null>(null);

  private readonly hostEl = inject(ElementRef);

  private renderedChorale: ParsedChorale | null = null;

  private readonly instanceId = `cs-${crypto.randomUUID()}`;

  /** Map from quarter-note beat index to the VexFlow Note objects active at that beat. */
  private beatNoteMap = new Map<number, Note[]>();

  /** The beat whose notes are currently highlighted (to allow un-highlighting). */
  private previousHighlightedBeat: number | null = null;

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
        this.beatNoteMap = new Map();
        this.previousHighlightedBeat = null;
        this.renderScore(current);
      }

      // Update note highlighting whenever currentBeat changes
      const beat = this.currentBeat();
      if (this.previousHighlightedBeat !== beat) {
        if (this.previousHighlightedBeat !== null) {
          this.toggleBeatHighlight(this.previousHighlightedBeat, false);
        }
        if (beat !== null) {
          this.toggleBeatHighlight(beat, true);
        }
        this.previousHighlightedBeat = beat;
      }
    });
  }

  /**
   * Add or remove the `vf-beat-highlight` CSS class on the SVG `<g>` element
   * VexFlow created for each note at the given beat.
   *
   * VexFlow stores fill/stroke as SVG presentation attributes, which CSS class
   * rules override — so a single classList operation per note is enough, with
   * no need to query every child path/line/rect individually.
   */
  private toggleBeatHighlight(beat: number, highlighted: boolean): void {
    const notes = this.beatNoteMap.get(beat) ?? [];
    for (const note of notes) {
      const svgEl = note.getSVGElement();
      if (!svgEl) {
        continue;
      }
      svgEl.classList.toggle('vf-beat-highlight', highlighted);
    }
  }

  private renderScore(chorale: ParsedChorale): void {
    const keyName = FIFTHS_TO_KEY[chorale.keyFifths] ?? 'C';
    const timeSig = `${chorale.timeBeats}/${chorale.timeBeatType}`;
    const rowCount = Math.ceil((chorale.measures.length || 1) / MEASURES_PER_ROW);

    let rowStartBeat = 0;

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
        this.renderRow(rowEl, rowId, rowMeasures, keyName, timeSig, rowIdx === 0, rowStartBeat);
      } catch {
        // Skip rows that fail to render (e.g. no DOM context in SSR)
      }

      // Advance beat position by the total duration of all measures in this row
      for (const measure of rowMeasures) {
        for (const n of (measure.partNotes[0] ?? [])) {
          rowStartBeat += vexDurationToBeats(n.vexDuration);
        }
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
    rowStartBeat: number,
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
    /** TextNote / GhostNote per bass note – rendered as a separate voice below the bass staff. */
    const rnNotes: Note[] = [];

    // Beat offsets per part within the row (initialised per measure below)
    const partBeat = [ 0, 0, 0, 0 ];

    /** Add a VexFlow note to beatNoteMap for every beat it is active at. */
    const registerBeat = (note: Note, partNote: ParsedMeasureNote, beatStart: number): number => {
      const d = vexDurationToBeats(partNote.vexDuration);
      if (partNote.note) {
        // Use same slot logic as ParsedChorale.beats: floor..ceil-1
        const firstSlot = Math.floor(beatStart);
        const lastSlot = Math.ceil(beatStart + d) - 1;
        for (let b = firstSlot; b <= lastSlot; b++) {
          if (!this.beatNoteMap.has(b)) {
            this.beatNoteMap.set(b, []);
          }
          this.beatNoteMap.get(b)!.push(note);
        }
      }
      return beatStart + d;
    };

    // Compute start beats for each measure within this row (based on soprano part)
    const measureStartBeats: number[] = [];
    let acc = rowStartBeat;
    for (const measure of measures) {
      measureStartBeats.push(acc);
      for (const n of (measure.partNotes[0] ?? [])) {
        acc += vexDurationToBeats(n.vexDuration);
      }
    }

    measures.forEach((measure, mIdx) => {
      if (mIdx > 0) {
        soprano.push(vf.BarNote());
        alto.push(vf.BarNote());
        tenor.push(vf.BarNote());
        bass.push(vf.BarNote());
        rnNotes.push(vf.BarNote());
      }

      const mStart = measureStartBeats[mIdx];
      partBeat[0] = mStart;
      partBeat[1] = mStart;
      partBeat[2] = mStart;
      partBeat[3] = mStart;

      const sopranoNotes = measure.partNotes[0] ?? [];
      const altoNotes = measure.partNotes[1] ?? [];
      const tenorNotes = measure.partNotes[2] ?? [];
      const bassNotes = measure.partNotes[3] ?? [];
      const fb = measure.figuredBass;
      const rns = measure.romanNumerals;

      sopranoNotes.forEach((n) => {
        const vexNote = createStaveNote(vf, n, 'treble', 1);
        soprano.push(vexNote);
        partBeat[0] = registerBeat(vexNote, n, partBeat[0]);
      });

      altoNotes.forEach((n) => {
        const vexNote = createStaveNote(vf, n, 'treble', -1, AnnotationVerticalJustify.BOTTOM);
        alto.push(vexNote);
        partBeat[1] = registerBeat(vexNote, n, partBeat[1]);
      });

      tenorNotes.forEach((n) => {
        const vexNote = createStaveNote(vf, n, 'bass', 1);
        tenor.push(vexNote);
        partBeat[2] = registerBeat(vexNote, n, partBeat[2]);
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
        partBeat[3] = registerBeat(bassNote, n, partBeat[3]);

        // Roman-numeral label (TextNote voice below the bass staff)
        const rn = rns?.[noteIdx] ?? null;
        if (rn) {
          const tn = vf.TextNote({
            text: rn.base,
            duration: n.vexDuration,
            ...(rn.superscript ? { superscript: rn.superscript } : {}),
            ...(rn.subscript ? { subscript: rn.subscript } : {}),
          });
          rnNotes.push(tn);
        } else {
          rnNotes.push(vf.GhostNote({ duration: n.vexDuration }));
        }
      });
    });

    const makeVoice = (notes: Note[]): Voice => vf.Voice(undefined).setMode(VoiceMode.SOFT)
      .addTickables(notes);

    const sopranoVoice = makeVoice(soprano);
    const altoVoice = makeVoice(alto);
    const tenorVoice = makeVoice(tenor);
    const bassVoice = makeVoice(bass);
    const rnVoice = makeVoice(rnNotes);

    // Configure TextNote appearance: place below the bass staff, centred under each note.
    for (const tickable of rnVoice.getTickables()) {
      if (tickable instanceof TextNote) {
        tickable.setLine(ROMAN_NUMERAL_LINE);
        tickable.setJustification(TextNote.Justification.CENTER);
      }
    }

    Accidental.applyAccidentals([ sopranoVoice, altoVoice ], keyName);
    Accidental.applyAccidentals([ tenorVoice, bassVoice ], keyName);

    const trebleStave = system.addStave({ voices: [ sopranoVoice, altoVoice ] });
    trebleStave.addClef('treble').addKeySignature(keyName);
    if (isFirstRow) {
      trebleStave.addTimeSignature(timeSig);
    }

    const bassStave = system.addStave({ voices: [ tenorVoice, bassVoice, rnVoice ] });
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
