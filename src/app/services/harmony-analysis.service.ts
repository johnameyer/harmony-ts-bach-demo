import { Injectable } from '@angular/core';
import {
  AbsoluteNote,
  ChordQuality,
  Harmonizer,
  IncompleteChord,
  Key,
  RomanNumeral,
  Scale,
  ScaleDegree,
} from 'harmony-ts';
import { ParsedChorale, RomanNumeralAnalysis } from './music-xml-parser.service';

const BASE_BEATS: Record<string, number> = {
  w: 4, h: 2, q: 1, 8: 0.5, 16: 0.25, 32: 0.125, 64: 0.0625,
};

function vexToBeat(vex: string): number {
  const dotless = vex.replace(/d+$/, '');
  const dots = (vex.match(/d+$/) ?? [ '' ])[0].length;
  const base = BASE_BEATS[dotless] ?? 1;
  let beats = base;
  let extra = base / 2;
  for (let i = 0; i < dots; i++) {
    beats += extra;
    extra /= 2;
  }
  return beats;
}

const EPS = 1e-9;

/**
 * Converts a RomanNumeral object to the structured display format used in the score.
 *
 * Mirrors the approach from harmony-ts-demo:
 *  - base text: roman numeral letters (with accidental prefix if any) + applied-chord suffix
 *  - superscript: quality symbol (○ or ø) followed by the top inversion figure
 *  - subscript: bottom inversion figure
 */
function toRomanNumeralAnalysis(rn: RomanNumeral): RomanNumeralAnalysis {
  // Extract just the roman numeral letters and optional sharp/flat prefix.
  // The regex also captures an optional quality character (o, 0, +) immediately after.
  const baseMatch = rn.name.match(/^([#b]?[viVI]+)(\+|o|0)?/);
  let romanLetters = baseMatch?.[1] ?? rn.name;
  const qualityChar = baseMatch?.[2] ?? '';

  // Quality prefix for superscript (○ fully-dim, ø half-dim).
  // Augmented (+) is appended to the base text instead.
  let superscriptPrefix = '';
  if (qualityChar === '0') {
    superscriptPrefix = 'ø';
  } else if (qualityChar === 'o') {
    superscriptPrefix = '○';
  } else if (qualityChar === '+') {
    romanLetters += '+';
  }

  const [ fig1, fig2 ] = rn.inversionSymbol;

  // Applied-chord designation appended to base text (e.g. "/V", "/ii")
  const appliedSuffix =
    rn.applied !== null ? `/${ScaleDegree.toRomanNumeral(rn.applied)}` : '';

  return {
    base: romanLetters + appliedSuffix,
    superscript: superscriptPrefix + (fig1 ?? ''),
    subscript: fig2 ?? '',
  };
}

@Injectable({ providedIn: 'root' })
export class HarmonyAnalysisService {
  /**
   * Runs roman-numeral analysis on a parsed chorale and stores the results
   * directly in each measure's `romanNumerals` array (aligned with bass notes).
   *
   * Algorithm:
   *  1. Build one IncompleteChord per quarter-note beat, skipping any notes
   *     already identified as non-harmonic (figuration labels).
   *  2. Walk through the constraints using Harmonizer.matchingHarmony, taking
   *     the first valid match at each step.
   *  3. On failure restart from the next beat (marking the failed beat "?"),
   *     using the tonic as the new context — as described in the issue.
   */
  analyze(chorale: ParsedChorale): void {
    const scale = this.buildScale(chorale);
    const harmonizer = new Harmonizer({});
    const beatConstraints = this.buildBeatConstraints(chorale);
    if (beatConstraints.length === 0) {
      return;
    }

    const constraints = beatConstraints.map((b) => b.constraint);

    // Starting / restart context: treat the tonic as the implicit "previous" chord.
    const tonicRN = new RomanNumeral(
      {
        scaleDegree: ScaleDegree.TONIC,
        quality:
          scale[1] === Scale.Quality.MAJOR
            ? ChordQuality.MAJOR
            : ChordQuality.MINOR,
      },
      scale,
    );

    const romanByBeat = new Map<number, RomanNumeralAnalysis | null>();
    let position = 0;
    let prevRN: RomanNumeral = tonicRN;

    while (position < beatConstraints.length) {
      const gen = harmonizer.matchingHarmony(constraints, position, prevRN);
      const result = gen.next();

      if (result.done) {
        // Cannot harmonize this beat – mark as unknown and restart from next beat.
        romanByBeat.set(beatConstraints[position].beatIndex, null);
        prevRN = tonicRN;
        position++;
      } else {
        const [ matchedChords, nextRN ] = result.value;
        for (let i = 0; i < matchedChords.length; i++) {
          const beatIndex = beatConstraints[position + i]?.beatIndex;
          if (beatIndex !== undefined) {
            const rn = matchedChords[i]?.romanNumeral;
            romanByBeat.set(beatIndex, rn ? toRomanNumeralAnalysis(rn) : null);
          }
        }
        position += matchedChords.length;
        prevRN = nextRN;
      }
    }

    this.applyToMeasures(chorale, romanByBeat);
  }

  /** Convert keyFifths + isMinor into a harmony-ts Scale tuple. */
  private buildScale(chorale: ParsedChorale): Scale {
    if (chorale.isMinor) {
      // The Key enum values equal the circle-of-fifths position for major keys.
      // The relative minor tonic is +3 steps around the circle of fifths.
      const minorKey = Math.max(-7, Math.min(7, chorale.keyFifths + 3)) as Key;
      return [ minorKey, Scale.Quality.MINOR ];
    }
    return [ chorale.keyFifths as Key, Scale.Quality.MAJOR ];
  }

  /**
   * Build an IncompleteChord for every quarter-note beat in the chorale,
   * including only notes that:
   *   - start exactly on a quarter-note boundary, AND
   *   - are not tagged as a non-harmonic (figuration) tone.
   */
  private buildBeatConstraints(
    chorale: ParsedChorale,
  ): { beatIndex: number; constraint: IncompleteChord }[] {
    // beatMap: beat index → voices array [soprano, alto, tenor, bass]
    const beatMap = new Map<number, (AbsoluteNote | undefined)[]>();
    let measureStart = 0;

    for (const measure of chorale.measures) {
      for (
        let partIdx = 0;
        partIdx < Math.min(measure.partNotes.length, 4);
        partIdx++
      ) {
        let partBeat = measureStart;
        for (const n of (measure.partNotes[partIdx] ?? [])) {
          const isOnBeat =
            Math.abs(partBeat - Math.round(partBeat)) < EPS;
          if (isOnBeat && n.note && !n.figuration) {
            const key = Math.round(partBeat);
            if (!beatMap.has(key)) {
              beatMap.set(key, [ undefined, undefined, undefined, undefined ]);
            }
            beatMap.get(key)![partIdx] = n.note;
          }
          partBeat += vexToBeat(n.vexDuration);
        }
      }
      // Advance measure start using the soprano part duration.
      for (const n of (measure.partNotes[0] ?? [])) {
        measureStart += vexToBeat(n.vexDuration);
      }
    }

    return Array.from(beatMap.entries())
      .sort(([ a ], [ b ]) => a - b)
      .map(([ beatIndex, voices ]) => ({
        beatIndex,
        constraint: new IncompleteChord({ voices }),
      }));
  }

  /**
   * Write the analysis results back into each measure's `romanNumerals` array,
   * which is aligned with the bass notes (partNotes[3]).
   *
   * A bass note at a quarter-note boundary gets the roman numeral label for
   * that beat; all other notes (sub-beat, non-boundary) get null (no label).
   * A beat that was attempted but failed analysis is stored as "?" label.
   */
  private applyToMeasures(
    chorale: ParsedChorale,
    romanByBeat: Map<number, RomanNumeralAnalysis | null>,
  ): void {
    let measureStart = 0;
    for (const measure of chorale.measures) {
      const bassNotes = measure.partNotes[3] ?? [];
      measure.romanNumerals = bassNotes.map(() => null);

      let bassBeat = measureStart;
      for (let i = 0; i < bassNotes.length; i++) {
        const key = Math.round(bassBeat);
        if (Math.abs(bassBeat - key) < EPS && romanByBeat.has(key)) {
          const rn = romanByBeat.get(key);
          // null in the map means "analysis attempted but failed" → show "?"
          measure.romanNumerals[i] = rn ?? { base: '?', superscript: '', subscript: '' };
        }
        bassBeat += vexToBeat(bassNotes[i].vexDuration);
      }

      for (const n of (measure.partNotes[0] ?? [])) {
        measureStart += vexToBeat(n.vexDuration);
      }
    }
  }
}
