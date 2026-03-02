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

/** Maximum generator iterations per beat when searching for the longest valid sequence. */
const MAX_SEARCH_RESULTS = 50;

/** Number of beats used to detect the home key. */
const KEY_DETECT_BEATS = 16;

/** Generator iteration limit used in the quick key-detection pass. */
const QUICK_MATCH_LIMIT = 30;

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
   *  2. Determine the home key by running a quick match-count for both the
   *     parallel major and the relative minor; choose whichever yields more
   *     successful matches in the opening measures.
   *  3. Walk through the constraints using Harmonizer.matchingHarmony with
   *     canModulate=true.  For each generator result apply the bass-anchored
   *     filter (all constraint voices must be present in the chord; if a bass
   *     voice is defined its note must also appear in the chord).  If the
   *     matched chord's inversion does not already place the constraint bass
   *     note in the lowest voice, relabel it to the correct inversion.
   *     Among all valid results in the first MAX_SEARCH_RESULTS iterations,
   *     prefer the one that covers the longest sequence of beats.
   *  4. On failure restart from the next beat (marking it "?") using the
   *     tonic chord as the new harmonic context.
   *  5. After analysis, confirm figuration labels: notes NOT in their
   *     surrounding chord(s) have their "?" suffix stripped; notes that are
   *     chord tones have their label cleared entirely.
   */
  analyze(chorale: ParsedChorale): void {
    // Constraints must be built before choosing the scale so that the
    // key-detection pass can reuse them.
    const beatConstraints = this.buildBeatConstraints(chorale);
    if (beatConstraints.length === 0) {
      return;
    }

    const constraints = beatConstraints.map((b) => b.constraint);
    const scale = this.buildScale(chorale, constraints);

    const harmonizer = new Harmonizer({ canModulate: true });

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
      let bestRelabeled: (RomanNumeral | null)[] | null = null;
      let bestLen = 0;
      let bestNext: RomanNumeral = tonicRN;

      try {
        let iterations = 0;
        for (const [ matchedChords, nextRN ] of harmonizer.matchingHarmony(constraints, position, prevRN)) {
          const relabeled = this.applyBassFilter(matchedChords, constraints, position);
          if (relabeled !== null && matchedChords.length > bestLen) {
            bestLen = matchedChords.length;
            bestRelabeled = relabeled;
            bestNext = nextRN;
          }
          iterations++;
          if (iterations >= MAX_SEARCH_RESULTS) {
            break;
          }
        }
      } catch {
        // harmony-ts may throw for out-of-range accidentals on unusual modulations.
        // Treat as unanalysable and move on.
      }

      if (bestRelabeled !== null) {
        for (let i = 0; i < bestRelabeled.length; i++) {
          const beatIndex = beatConstraints[position + i]?.beatIndex;
          if (beatIndex !== undefined) {
            const rn = bestRelabeled[i];
            if (rn) {
              romanByBeat.set(beatIndex, toRomanNumeralAnalysis(rn));
              chordByBeat.set(beatIndex, rn);
            }
          }
        }
        position += bestLen;
        prevRN = bestNext;
      } else {
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
   * Checks whether `matchedChords` satisfies the bass-anchored filter for
   * every beat in the sequence, and returns relabeled RomanNumeral objects
   * (correct inversion derived from the constraint bass) or null on failure.
   *
   * Filter criteria per beat:
   *  - Every note present in the constraint voices must exist in the chord.
   *  - If the bass voice (voices[3]) is defined, its note must also be in
   *    the chord (the inversion is then adjusted so that note becomes the
   *    chord bass).
   */
  private applyBassFilter(
    matchedChords: { romanNumeral: RomanNumeral }[],
    constraints: IncompleteChord[],
    position: number,
  ): (RomanNumeral | null)[] | null {
    const relabeled: (RomanNumeral | null)[] = [];
    for (let i = 0; i < matchedChords.length; i++) {
      const rn = matchedChords[i]?.romanNumeral;
      if (!rn) {
        relabeled.push(null);
        continue;
      }
      const voices = constraints[position + i]?.voices ?? [];
      const rnNoteNames = new Set(rn.notes.map((n) => n.simpleName));

      // All defined constraint voices must appear in the chord.
      for (const v of voices) {
        if (v !== null && v !== undefined && !rnNoteNames.has(v.simpleName)) {
          return null;
        }
      }

      // If the bass voice is defined, the chord must contain that note and we
      // relabel to the inversion that places it in the lowest position.
      const bassVoice = voices[3] as AbsoluteNote | undefined;
      if (bassVoice) {
        if (!rnNoteNames.has(bassVoice.simpleName)) {
          return null;
        }
        relabeled.push(this.relabelForBass(rn, bassVoice.simpleName));
      } else {
        relabeled.push(rn);
      }
    }
    return relabeled;
  }

  /**
   * Returns a (possibly new) RomanNumeral whose inversion places `bassSimpleName`
   * in the lowest voice.  If the chord already has that note in the bass, the
   * original object is returned unchanged.
   */
  private relabelForBass(rn: RomanNumeral, bassSimpleName: string): RomanNumeral {
    const noteNames = rn.notes.map((n) => n.simpleName);
    const idx = noteNames.indexOf(bassSimpleName);
    if (idx === -1 || idx === rn.inversion) {
      return rn;
    }
    return new RomanNumeral(
      {
        scaleDegree: rn.scaleDegree,
        quality: rn.quality,
        inversion: idx,
        hasSeventh: rn.hasSeventh,
        accidental: rn.accidental,
        applied: rn.applied,
      },
      rn.scale,
    );
  }

  /**
   * Convert keyFifths + isMinor into a harmony-ts Scale tuple.
   *
   * When the MusicXML does not specify `<mode>minor`, both the parallel major
   * (keyFifths) and the relative minor (keyFifths + 3) are tried against the
   * opening constraints.  Whichever yields more successful bass-anchored matches
   * in the first KEY_DETECT_BEATS beats is chosen as the home key.
   */
  private buildScale(chorale: ParsedChorale, constraints: IncompleteChord[]): Scale {
    if (chorale.isMinor) {
      const minorKey = Math.max(-7, Math.min(7, chorale.keyFifths + 3)) as Key;
      return [ minorKey, Scale.Quality.MINOR ];
    }

    const majorScale: Scale = [ chorale.keyFifths as Key, Scale.Quality.MAJOR ];
    const relMinorFifths = chorale.keyFifths + 3;
    if (relMinorFifths < -7 || relMinorFifths > 7) {
      return majorScale;
    }
    const minorScale: Scale = [ relMinorFifths as Key, Scale.Quality.MINOR ];

    const majorCount = this.countQuickMatches(constraints, majorScale);
    const minorCount = this.countQuickMatches(constraints, minorScale);
    return minorCount > majorCount ? minorScale : majorScale;
  }

  /**
   * Quick key-detection pass: counts how many of the first KEY_DETECT_BEATS
   * beat constraints produce a valid bass-anchored match (all constraint notes
   * in the chord, constraint bass in the chord) under the given scale.
   */
  private countQuickMatches(constraints: IncompleteChord[], scale: Scale): number {
    const harmonizer = new Harmonizer({ canModulate: true });
    const tonic = new RomanNumeral(
      {
        scaleDegree: ScaleDegree.TONIC,
        quality:
          scale[1] === Scale.Quality.MAJOR
            ? ChordQuality.MAJOR
            : ChordQuality.MINOR,
      },
      scale,
    );

    const checkCount = Math.min(constraints.length, KEY_DETECT_BEATS);
    let prevRN: RomanNumeral = tonic;
    let successes = 0;

    for (let pos = 0; pos < checkCount; pos++) {
      const voices = constraints[pos].voices ?? [];
      const bassVoice = voices[3] as AbsoluteNote | undefined;

      let found = false;
      let count = 0;
      try {
        for (const [ chords, next ] of harmonizer.matchingHarmony(constraints, pos, prevRN)) {
          const rn = chords[0].romanNumeral;
          const rnNotes = new Set(rn.notes.map((n) => n.simpleName));
          const allIn = voices.every((v) => v === null || v === undefined || rnNotes.has(v.simpleName));
          const bassOk = !bassVoice || rnNotes.has(bassVoice.simpleName);
          if (allIn && bassOk) {
            prevRN = next;
            successes++;
            found = true;
            break;
          }
          count++;
          if (count >= QUICK_MATCH_LIMIT) {
            break;
          }
        }
      } catch {
        // harmony-ts may throw for out-of-range accidentals on unusual modulations.
      }

      if (!found) {
        prevRN = tonic;
      }
    }
    return successes;
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
