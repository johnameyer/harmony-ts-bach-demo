import { Injectable } from '@angular/core';
import {
  ChordQuality,
  Harmonizer,
  IncompleteChord,
  Key,
  RomanNumeral,
  Scale,
  ScaleDegree,
} from 'harmony-ts';
import { ParsedChorale, ParsedMeasureNote, RomanNumeralAnalysis } from './music-xml-parser.service';

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

/** Maximum harmonizer iterations per variant when searching for the longest valid match. */
const MAX_SEARCH_RESULTS = 50;

/**
 * Number of slices (at half-beat resolution) used for key detection.
 * 32 half-beat slices ≈ 16 quarter-note beats.
 */
const KEY_DETECT_SLICES = 32;

/** Generator iteration limit used in the quick key-detection pass. */
const QUICK_MATCH_LIMIT = 30;

/**
 * A "slice" captures the harmonic constraint at one sub-beat position.
 *
 * Two variants are built per slice:
 *  - fullConstraint:     all notes that START at this position (including figurated ones).
 *  - filteredConstraint: only non-figurated notes that start at this position.
 *
 * The analysis first tries the full variant so that potential non-chord tones
 * (appoggiatura, passing tones) are offered to the harmonizer as real chord tones.
 * Only when the full variant fails does the filtered variant act as a fallback.
 */
interface BeatSlice {
  /**
   * Half-beat key: `Math.round(beatPosition * 2)`.
   * Used as the Map key throughout (integers, avoids float comparisons).
   */
  beatKey: number;
  /** Actual fractional beat position: `beatKey / 2`. */
  beatPosition: number;
  /** IncompleteChord including ALL notes starting at this position. */
  fullConstraint: IncompleteChord;
  /** IncompleteChord with only non-figurated notes starting here. */
  filteredConstraint: IncompleteChord;
}

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
   *  1. Build one BeatSlice per eighth-note (half-beat) position from the chorale.
   *     Each slice carries two IncompleteChord variants:
   *       - fullConstraint:     all notes that START at this position (incl. figurated).
   *       - filteredConstraint: only non-figurated notes that start here.
   *  2. Determine the home key by counting how many filtered, quarter-note-boundary
   *     constraints match under each candidate scale (parallel major vs relative minor).
   *  3. Walk through the slices using a nested iterable pipeline:
   *       a. At each position, build a "stream of possible vertical slices" by
   *          passing the full-constraint array first through matchingHarmony.
   *       b. Among all results in the first MAX_SEARCH_RESULTS iterations, keep
   *          the one with the most positions covered (longest match), provided the
   *          chord's actual bass note (notes[inversion]) matches the constraint's
   *          bass voice.  The roman numeral is taken directly from the harmonizer
   *          output — no re-labelling is performed.
   *       c. If the full-constraint stream yields no valid match, repeat (a)-(b)
   *          with the filtered-constraint array (figurated notes removed).
   *       d. On failure mark the current slice "?" and restart from the next one.
   *  4. After analysis, confirm figuration labels: notes NOT in their surrounding
   *     chord(s) are confirmed non-chord tones (trailing "?" stripped); notes that
   *     ARE chord tones have their label cleared entirely.
   */
  analyze(chorale: ParsedChorale): void {
    const slices = this.buildAllSlices(chorale);
    if (slices.length === 0) {
      return;
    }

    // Key detection uses only filtered slices at quarter-note boundaries.
    const quarterFiltered = slices
      .filter((s) => s.beatKey % 2 === 0)
      .map((s) => s.filteredConstraint);
    const scale = this.buildScale(chorale, quarterFiltered);

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
    const chordByBeat = new Map<number, RomanNumeral>();

    let position = 0;
    let prevRN: RomanNumeral = tonicRN;

    while (position < slices.length) {
      const remaining = slices.slice(position);

      let bestChords: { romanNumeral: RomanNumeral }[] | null = null;
      let bestLen = 0;
      let bestNext: RomanNumeral = tonicRN;

      // Variant stream: try full constraints first (figurated notes as potential
      // chord tones); fall back to filtered only when full yields nothing.
      for (const constraints of [
        remaining.map((s) => s.fullConstraint),
        remaining.map((s) => s.filteredConstraint),
      ]) {
        try {
          let iterations = 0;
          for (const [ chords, next ] of harmonizer.matchingHarmony(constraints, 0, prevRN)) {
            if (this.passesBassFilter(chords, constraints) && chords.length > bestLen) {
              bestLen = chords.length;
              bestChords = chords;
              bestNext = next;
            }
            if (++iterations >= MAX_SEARCH_RESULTS) {
              break;
            }
          }
        } catch {
          // harmony-ts may throw for out-of-range accidentals on unusual modulations.
        }
        if (bestLen > 0) {
          break; // Full-constraint stream succeeded — do not fall through to filtered.
        }
      }

      if (bestChords !== null) {
        for (let i = 0; i < bestLen; i++) {
          const beatKey = slices[position + i]?.beatKey;
          if (beatKey !== undefined) {
            const rn = bestChords[i]?.romanNumeral;
            if (rn) {
              romanByBeat.set(beatKey, toRomanNumeralAnalysis(rn));
              chordByBeat.set(beatKey, rn);
            }
          }
        }
        position += bestLen;
        prevRN = bestNext;
      } else {
        // Cannot harmonize this slice — mark as unknown and restart from next.
        romanByBeat.set(slices[position].beatKey, null);
        prevRN = tonicRN;
        position++;
      }
    }

    this.applyToMeasures(chorale, romanByBeat);
    this.confirmFigurations(chorale, chordByBeat);
  }

  /**
   * Returns true if every chord in the sequence has its actual bass note
   * (notes[inversion]) matching the constraint's bass voice (voices[3]).
   * Positions where the constraint has no bass voice are always accepted.
   *
   * This filter selects the correct inversion from the harmonizer's output
   * without re-labelling: for example, iv6 (G in bass) is accepted over iv
   * root position (E in bass) when the constraint bass is G.
   */
  private passesBassFilter(
    chords: { romanNumeral: RomanNumeral }[],
    constraints: IncompleteChord[],
  ): boolean {
    for (let i = 0; i < chords.length; i++) {
      const rn = chords[i]?.romanNumeral;
      if (!rn) {
        continue;
      }
      const bassConstraint = constraints[i]?.voices?.[3];
      if (!bassConstraint) {
        continue;
      }
      const chordBassNote = rn.notes[rn.inversion];
      if (chordBassNote && chordBassNote.simpleName !== bassConstraint.simpleName) {
        return false;
      }
    }
    return true;
  }

  /**
   * Build one BeatSlice for every eighth-note (half-beat) position in the
   * chorale.  Only notes that start exactly on a half-beat boundary are
   * included; held notes from earlier beats are omitted.
   *
   * Full variant:     all starting notes, including those tagged as figurations.
   * Filtered variant: only notes with no figuration label.
   */
  private buildAllSlices(chorale: ParsedChorale): BeatSlice[] {
    // fullVoices / filteredVoices: beatKey → [soprano, alto, tenor, bass]
    const fullVoices = new Map<number, (IncompleteChord['voices'][number])[]>();
    const filteredVoices = new Map<number, (IncompleteChord['voices'][number])[]>();

    const ensureVoices = (
      map: Map<number, (IncompleteChord['voices'][number])[]>,
      key: number,
    ) => {
      if (!map.has(key)) {
        map.set(key, [ undefined, undefined, undefined, undefined ]);
      }
      return map.get(key)!;
    };

    let measureStart = 0;

    for (const measure of chorale.measures) {
      for (let partIdx = 0; partIdx < Math.min(measure.partNotes.length, 4); partIdx++) {
        let partBeat = measureStart;
        for (const n of (measure.partNotes[partIdx] ?? [])) {
          if (n.note) {
            // Round to the nearest half-beat boundary.
            const beatKey = Math.round(partBeat * 2);
            if (Math.abs(partBeat - beatKey / 2) < EPS) {
              ensureVoices(fullVoices, beatKey)[partIdx] = n.note;
              if (!n.figuration) {
                ensureVoices(filteredVoices, beatKey)[partIdx] = n.note;
              }
            }
          }
          partBeat += vexToBeat(n.vexDuration);
        }
      }
      for (const n of (measure.partNotes[0] ?? [])) {
        measureStart += vexToBeat(n.vexDuration);
      }
    }

    const allKeys = new Set([ ...fullVoices.keys(), ...filteredVoices.keys() ]);
    return Array.from(allKeys)
      .sort((a, b) => a - b)
      .map((beatKey) => ({
        beatKey,
        beatPosition: beatKey / 2,
        fullConstraint: new IncompleteChord({
          voices: fullVoices.get(beatKey) ?? [ undefined, undefined, undefined, undefined ],
        }),
        filteredConstraint: new IncompleteChord({
          voices: filteredVoices.get(beatKey) ?? [ undefined, undefined, undefined, undefined ],
        }),
      }));
  }

  /**
   * Convert keyFifths + isMinor into a harmony-ts Scale tuple.
   *
   * When the MusicXML does not specify `<mode>minor`, both the parallel major
   * (keyFifths) and the relative minor (keyFifths + 3) are tried against the
   * opening constraints.  Whichever yields more successful bass-anchored matches
   * in the first KEY_DETECT_SLICES slices is chosen as the home key.
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
   * Quick key-detection pass: counts how many of the first KEY_DETECT_SLICES
   * constraints produce a valid bass-anchored match under the given scale.
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

    const checkCount = Math.min(constraints.length, KEY_DETECT_SLICES);
    let prevRN: RomanNumeral = tonic;
    let successes = 0;

    for (let pos = 0; pos < checkCount; pos++) {
      let found = false;
      let count = 0;
      try {
        for (const [ chords, next ] of harmonizer.matchingHarmony(constraints, pos, prevRN)) {
          if (this.passesBassFilter([ chords[0] ], [ constraints[pos] ])) {
            prevRN = next;
            successes++;
            found = true;
            break;
          }
          if (++count >= QUICK_MATCH_LIMIT) {
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
   * Write the analysis results back into each measure's `romanNumerals` array,
   * aligned with the bass notes (partNotes[3]).
   *
   * Any bass note that starts exactly on a half-beat boundary and has a
   * corresponding entry in `romanByBeat` receives that label.  A null entry
   * (analysis attempted but failed) is rendered as "?".
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
        // Use half-beat precision so eighth-note bass positions are also labelled.
        const beatKey = Math.round(bassBeat * 2);
        if (Math.abs(bassBeat - beatKey / 2) < EPS && romanByBeat.has(beatKey)) {
          const rn = romanByBeat.get(beatKey);
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
   * Post-process figuration labels using the chord analysis.
   *
   * - Tentative figuration labels ("P?", "Sus?", etc.) are checked against
   *   the chord(s) at the surrounding half-beat positions.
   * - If the note's pitch is NOT in any surrounding chord → confirmed
   *   non-chord tone: remove the trailing "?".
   * - If the note's pitch IS in a surrounding chord → clear the label entirely
   *   (the figuration detector mis-classified it as non-harmonic).
   * - If no chord data is available at the surrounding positions, the tentative
   *   label is left unchanged.
   */
  private confirmFigurations(
    chorale: ParsedChorale,
    chordByBeat: Map<number, RomanNumeral>,
  ): void {
    let measureStart = 0;
    for (const measure of chorale.measures) {
      for (let partIdx = 0; partIdx < 4; partIdx++) {
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

    // Check the chord at the note's exact half-beat position, plus the
    // enclosing quarter-note beat boundaries (floor and ceil).
    const exactKey = Math.round(partBeat * 2);
    const floorKey = Math.floor(partBeat) * 2;
    const ceilKey = Math.ceil(partBeat) * 2;
    const keysToCheck = [ ...new Set([ exactKey, floorKey, ceilKey ]) ];

    const noteName = n.note.simpleName;
    let hasChordData = false;
    let isChordTone = false;

    for (const key of keysToCheck) {
      const chord = chordByBeat.get(key);
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
      return;
    }

    if (isChordTone) {
      n.figuration = null;
    } else {
      n.figuration = n.figuration.replace(/\?$/, '');
    }
  }
}
