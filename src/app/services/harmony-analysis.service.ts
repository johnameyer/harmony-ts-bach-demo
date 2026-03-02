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
import { ParsedChorale, ParsedMeasureNote, RomanNumeralAnalysis } from './music-xml-parser.service';
import { isSubBeat } from './figuration-detector';

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
   *  2. Walk through the constraints using Harmonizer.matchingHarmony with
   *     canModulate=true, taking the first result that is an **exact** match
   *     (no extra notes in the matched chord beyond the constraint voices).
   *  3. On failure restart from the next beat (marking the failed beat "?"),
   *     using the tonic as the new context — as described in the issue.
   *  4. After analysis, confirm figuration labels: notes that are NOT in their
   *     surrounding chord(s) have their "?" suffix removed; notes that ARE
   *     chord tones have their label cleared entirely.
   */
  analyze(chorale: ParsedChorale): void {
    const scale = this.buildScale(chorale);
    const harmonizer = new Harmonizer({ canModulate: true });
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
    /** The actual RomanNumeral objects, used later for figuration confirmation. */
    const chordByBeat = new Map<number, RomanNumeral>();

    let position = 0;
    let prevRN: RomanNumeral = tonicRN;

    while (position < beatConstraints.length) {
      const bc = beatConstraints[position];
      const definedVoices = (bc.constraint.voices ?? [])
        .filter((v): v is AbsoluteNote => v !== null && v !== undefined).length;

      // Apply exact matching (no extra chord notes beyond the constraint voices)
      // only when enough voices are defined for a reliable match.
      // With fewer voices, fall back to the standard first-result behaviour.
      const requireExact = definedVoices >= 3;

      let found = false;

      try {
        for (const [ matchedChords, nextRN ] of harmonizer.matchingHarmony(constraints, position, prevRN)) {
          if (requireExact && !this.isExactMatch(matchedChords, constraints, position)) {
            continue;
          }

          for (let i = 0; i < matchedChords.length; i++) {
            const beatIndex = beatConstraints[position + i]?.beatIndex;
            if (beatIndex !== undefined) {
              const rn = matchedChords[i]?.romanNumeral;
              if (rn) {
                romanByBeat.set(beatIndex, toRomanNumeralAnalysis(rn));
                chordByBeat.set(beatIndex, rn);
              }
            }
          }

          position += matchedChords.length;
          prevRN = nextRN;
          found = true;
          break;
        }
      } catch {
        // harmony-ts may throw for out-of-range accidentals on unusual modulations.
        // Treat as unanalysable and move on.
      }

      if (!found) {
        // Cannot harmonize this beat – mark as unknown and restart from next beat.
        romanByBeat.set(beatConstraints[position].beatIndex, null);
        prevRN = tonicRN;
        position++;
      }
    }

    this.applyToMeasures(chorale, romanByBeat);
    this.confirmFigurations(chorale, chordByBeat);
  }

  /**
   * Returns true iff every matched chord contains **only** notes that are
   * present in the corresponding constraint's voices (strict / exact match).
   * The harmonizer normally allows missing notes; this filter removes results
   * where the chord introduces a note absent from all four constraint voices.
   */
  private isExactMatch(
    matchedChords: { romanNumeral: RomanNumeral }[],
    constraints: IncompleteChord[],
    position: number,
  ): boolean {
    for (let i = 0; i < matchedChords.length; i++) {
      const rn = matchedChords[i]?.romanNumeral;
      if (!rn) {
        continue;
      }
      const constraintVoices = constraints[position + i]?.voices ?? [];
      const constraintNoteNames = new Set(
        constraintVoices
          .filter((v): v is AbsoluteNote => v !== null && v !== undefined)
          .map((v) => v.simpleName),
      );
      const chordNoteNames = rn.notes.map((n) => n.simpleName);
      if (chordNoteNames.some((n) => !constraintNoteNames.has(n))) {
        return false;
      }
    }
    return true;
  }

  /** Convert keyFifths + isMinor into a harmony-ts Scale tuple.
   *
   * When the MusicXML does not specify `<mode>`, we use a heuristic:
   * if the first bass note matches the relative minor tonic, treat the
   * piece as minor (Bach chorales always start with the tonic in the bass).
   */
  private buildScale(chorale: ParsedChorale): Scale {
    if (chorale.isMinor) {
      const minorKey = Math.max(-7, Math.min(7, chorale.keyFifths + 3)) as Key;
      return [ minorKey, Scale.Quality.MINOR ];
    }

    // Heuristic: check if first bass note is the relative minor tonic.
    const relMinorFifths = chorale.keyFifths + 3;
    if (relMinorFifths >= -7 && relMinorFifths <= 7) {
      const relMinorKey = relMinorFifths as Key;
      const relMinorTonic = Key.toNote(relMinorKey).simpleName;
      const firstBass = this.findFirstBassNote(chorale);
      if (firstBass?.simpleName === relMinorTonic) {
        return [ relMinorKey, Scale.Quality.MINOR ];
      }
    }

    return [ chorale.keyFifths as Key, Scale.Quality.MAJOR ];
  }

  /** Returns the first non-null bass note in the chorale (part index 3). */
  private findFirstBassNote(chorale: ParsedChorale): AbsoluteNote | null {
    for (const measure of chorale.measures) {
      for (const n of (measure.partNotes[3] ?? [])) {
        if (n.note) {
          return n.note;
        }
      }
    }
    return null;
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

  /**
   * Post-process figuration labels using the chord analysis:
   *
   * - Notes with a tentative figuration label ("P?", "Sus?", etc.) are
   *   checked against the chord(s) at surrounding beats.
   * - If the note's pitch is NOT in any surrounding chord → confirmed
   *   non-chord tone: remove the trailing "?".
   * - If the note's pitch IS in a surrounding chord → it turned out to be
   *   a chord tone: clear the label entirely.
   * - If no chord analysis is available at the surrounding beat(s), the
   *   tentative label ("?"-suffixed) is left unchanged.
   */
  private confirmFigurations(
    chorale: ParsedChorale,
    chordByBeat: Map<number, RomanNumeral>,
  ): void {
    let measureStart = 0;
    for (const measure of chorale.measures) {
      for (let partIdx = 0; partIdx < 4; partIdx++) { // 0=S, 1=A, 2=T, 3=B
        let partBeat = measureStart;
        for (const n of (measure.partNotes[partIdx] ?? [])) {
          this.updateFigurationLabel(n, partBeat, chordByBeat);
          partBeat += vexToBeat(n.vexDuration);
        }
      }
      for (const n of (measure.partNotes[0] ?? [])) {
        measureStart += vexToBeat(n.vexDuration);
      }
    }
  }

  private updateFigurationLabel(
    n: ParsedMeasureNote,
    partBeat: number,
    chordByBeat: Map<number, RomanNumeral>,
  ): void {
    if (!n.figuration || !n.note) {
      return;
    }

    // For sub-beat notes, check both the chord before and after.
    // For beat-boundary notes, check only the chord at that beat.
    const beatsBefore = [ Math.floor(partBeat) ];
    if (isSubBeat(n.vexDuration)) {
      beatsBefore.push(Math.ceil(partBeat));
    }

    const noteName = n.note.simpleName;
    let hasChordData = false;
    let isChordTone = false;

    for (const beat of beatsBefore) {
      const chord = chordByBeat.get(beat);
      if (!chord) {
        continue;
      }
      hasChordData = true;
      if (chord.notes.some((cn) => cn.simpleName === noteName)) {
        isChordTone = true;
        break;
      }
    }

    if (!hasChordData) {
      // No chord info → leave label as-is (with "?")
      return;
    }

    if (isChordTone) {
      // Chord tone misclassified as non-harmonic → clear the label
      n.figuration = null;
    } else {
      // Confirmed non-chord tone → strip the trailing "?"
      n.figuration = n.figuration.replace(/\?$/, '');
    }
  }
}
