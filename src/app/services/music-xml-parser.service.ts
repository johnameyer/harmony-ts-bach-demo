import { Injectable } from '@angular/core';
import { AbsoluteNote, Accidental } from 'harmony-ts';

export interface ParsedMeasureNote {
  note: AbsoluteNote | null;
  vexDuration: string;
}

export interface ParsedMeasure {
  /** Note events per part (indices 0–3 = Soprano/Alto/Tenor/Bass). */
  partNotes: ParsedMeasureNote[][];
  /** Figured-bass figures per note, aligned with partNotes[3] (Bass). */
  figuredBass: string[][];
}

export interface ParsedChorale {
  title: string;
  partNames: string[];
  beats: AbsoluteNote[][][];
  /** MusicXML key-signature fifths value (−7…+7). */
  keyFifths: number;
  /** Numerator of the time signature. */
  timeBeats: number;
  /** Denominator of the time signature. */
  timeBeatType: number;
  measures: ParsedMeasure[];
}

interface NoteEvent {
  startBeat: number;
  duration: number;
  note: AbsoluteNote;
}

const MUSICXML_TYPE_TO_VEX: Record<string, string> = {
  breve: 'w',
  whole: 'w',
  half: 'h',
  quarter: 'q',
  eighth: '8',
  '16th': '16',
  '32nd': '32',
  '64th': '64',
};

@Injectable({ providedIn: 'root' })
export class MusicXmlParserService {
  parse(xmlString: string): ParsedChorale {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'application/xml');

    const title =
      doc.querySelector('work-title')?.textContent?.trim()
      ?? doc.querySelector('movement-title')?.textContent?.trim()
      ?? 'Unknown';

    const partElements = Array.from(doc.querySelectorAll('part'));
    const partListElements = Array.from(doc.querySelectorAll('score-part'));
    const partNames = partListElements.map(
      (p) => p.querySelector('part-name')?.textContent?.trim() ?? 'Unknown',
    );

    const keyFifths = parseInt(
      doc.querySelector('key > fifths')?.textContent ?? '0',
      10,
    );
    const timeBeats = parseInt(
      doc.querySelector('time > beats')?.textContent ?? '4',
      10,
    );
    const timeBeatType = parseInt(
      doc.querySelector('time > beat-type')?.textContent ?? '4',
      10,
    );

    const allPartEvents: NoteEvent[][] = partElements.map((part) => this.extractNoteEvents(part),
    );

    const totalBeats = allPartEvents.reduce((max, events) => {
      const partMax = events.reduce(
        (m, e) => Math.max(m, e.startBeat + e.duration),
        0,
      );
      return Math.max(max, partMax);
    }, 0);

    const numSlots = Math.ceil(totalBeats);

    const beats: AbsoluteNote[][][] = Array.from({ length: numSlots }, () => Array.from({ length: partElements.length }, () => []),
    );

    allPartEvents.forEach((events, partIndex) => {
      for (const event of events) {
        const firstSlot = Math.floor(event.startBeat);
        const lastSlot = Math.ceil(event.startBeat + event.duration) - 1;
        for (let slot = firstSlot; slot <= lastSlot; slot++) {
          if (slot >= 0 && slot < numSlots) {
            beats[slot][partIndex].push(event.note);
          }
        }
      }
    });

    const voiceParts = partElements.slice(0, 4);
    const fbPartIndex = this.findFiguredBassPartIndex(partElements);
    const fbPart = fbPartIndex !== -1 ? partElements[fbPartIndex] : null;
    const measures = this.extractMeasures(voiceParts, fbPart);

    return { title, partNames, beats, keyFifths, timeBeats, timeBeatType, measures };
  }

  private findFiguredBassPartIndex(parts: Element[]): number {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].querySelector('figured-bass')) {
        return i;
      }
    }
    return -1;
  }

  private extractMeasures(voiceParts: Element[], fbPart: Element | null): ParsedMeasure[] {
    const measureCount = voiceParts[0]?.querySelectorAll('measure').length ?? 0;
    const perPartMeasures = voiceParts.map((part) => this.extractMeasureNotesPerPart(part));
    const fbPerMeasure = fbPart ? this.extractFiguredBassPerMeasure(fbPart) : [];

    return Array.from({ length: measureCount }, (_, m) => ({
      partNotes: voiceParts.map((_, pi) => perPartMeasures[pi]?.[m] ?? []),
      figuredBass: fbPerMeasure[m] ?? [],
    }));
  }

  private extractMeasureNotesPerPart(part: Element): ParsedMeasureNote[][] {
    return Array.from(part.querySelectorAll('measure')).map((measure) => {
      const notes: ParsedMeasureNote[] = [];
      for (const child of Array.from(measure.children)) {
        if (child.tagName !== 'note') {
          continue;
        }
        if (child.querySelector('chord')) {
          continue;
        }

        const typeText = child.querySelector('type')?.textContent ?? 'quarter';
        const dotCount = child.querySelectorAll('dot').length;
        const base = MUSICXML_TYPE_TO_VEX[typeText] ?? 'q';
        const vexDuration = base + 'd'.repeat(dotCount);

        if (child.querySelector('rest')) {
          notes.push({ note: null, vexDuration });
          continue;
        }

        const step = child.querySelector('pitch > step')?.textContent?.toUpperCase();
        const octaveText = child.querySelector('pitch > octave')?.textContent;
        const alterText = child.querySelector('pitch > alter')?.textContent;

        if (!step || !octaveText) {
          notes.push({ note: null, vexDuration });
          continue;
        }

        const octave = parseInt(octaveText, 10);
        const alter = alterText ? Math.round(parseFloat(alterText)) : 0;
        notes.push({ note: new AbsoluteNote(step, alter as Accidental, octave), vexDuration });
      }
      return notes;
    });
  }

  private extractFiguredBassPerMeasure(fbPart: Element): string[][][] {
    const SUFFIX_TO_ACCIDENTAL: Record<string, string> = {
      backslash: '♯',
      cross: '♯',
      slash: '♭',
      'double-slash': '♯♯',
      flat: '♭',
      'flat-flat': '♭♭',
      sharp: '♯',
      'sharp-sharp': '♯♯',
      natural: '♮',
    };

    return Array.from(fbPart.querySelectorAll('measure')).map((measure) => {
      const measureFB: string[][] = [];
      let pendingFigures: string[] | null = null;

      for (const child of Array.from(measure.children)) {
        if (child.tagName === 'figured-bass') {
          pendingFigures = Array.from(child.querySelectorAll('figure')).map((fig) => {
            const num = fig.querySelector('figure-number')?.textContent ?? '';
            const suffix = fig.querySelector('suffix')?.textContent ?? '';
            const acc = SUFFIX_TO_ACCIDENTAL[suffix] ?? '';
            return acc ? `${num}${acc}` : num;
          });
        } else if (child.tagName === 'note' && !child.querySelector('chord')) {
          measureFB.push(pendingFigures ?? []);
          pendingFigures = null;
        }
      }

      return measureFB;
    });
  }

  private extractNoteEvents(part: Element): NoteEvent[] {
    const events: NoteEvent[] = [];
    let divisions = 1;
    let currentBeat = 0;

    for (const measure of Array.from(part.querySelectorAll('measure'))) {
      const divisionsEl = measure.querySelector('attributes > divisions');
      if (divisionsEl?.textContent) {
        divisions = parseInt(divisionsEl.textContent, 10);
      }

      let measureBeat = currentBeat;
      let lastNonChordBeat = currentBeat;

      for (const note of Array.from(measure.querySelectorAll('note'))) {
        const isChord = note.querySelector('chord') !== null;
        const durationEl = note.querySelector('duration');
        const duration = durationEl?.textContent
          ? parseInt(durationEl.textContent, 10) / divisions
          : 0;

        if (note.querySelector('rest')) {
          if (!isChord) {
            lastNonChordBeat = measureBeat;
            measureBeat += duration;
          }
          continue;
        }

        const stepEl = note.querySelector('pitch > step');
        const octaveEl = note.querySelector('pitch > octave');
        const alterEl = note.querySelector('pitch > alter');

        if (!stepEl?.textContent || !octaveEl?.textContent) {
          if (!isChord) {
            lastNonChordBeat = measureBeat;
            measureBeat += duration;
          }
          continue;
        }

        const letter = stepEl.textContent.toUpperCase();
        const octave = parseInt(octaveEl.textContent, 10);
        const alterValue = alterEl?.textContent
          ? Math.round(parseFloat(alterEl.textContent))
          : 0;
        const accidental = alterValue as Accidental;

        const absoluteNote = new AbsoluteNote(letter, accidental, octave);
        const noteBeat = isChord ? lastNonChordBeat : measureBeat;

        events.push({ startBeat: noteBeat, duration, note: absoluteNote });

        if (!isChord) {
          lastNonChordBeat = measureBeat;
          measureBeat += duration;
        }
      }

      currentBeat = measureBeat;
    }

    return events;
  }
}
