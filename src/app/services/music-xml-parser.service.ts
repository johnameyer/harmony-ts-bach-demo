import { Injectable } from '@angular/core';
import { AbsoluteNote, Accidental } from 'harmony-ts';

export interface ParsedChorale {
  title: string;
  partNames: string[];
  beats: AbsoluteNote[][][];
}

interface NoteEvent {
  startBeat: number;
  duration: number;
  note: AbsoluteNote;
}

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

    return { title, partNames, beats };
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
