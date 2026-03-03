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

/** Number of beats used for key detection. */
const KEY_DETECT_BEATS = 16;

/** Generator iteration limit used in the quick key-detection pass. */
const QUICK_MATCH_LIMIT = 30;

/**
 * A single note option for one voice at a quarter-beat position.
 * Tracks whether this note has a figuration label so filtered variants can
 * exclude it.
 */
interface VoiceNote {
  note: import('harmony-ts').AbsoluteNote;
  figurated: boolean;
}

/**
 * One entry per quarter-note beat in the chorale.
 *
 *  - `beatIndex`:          integer quarter-beat position (0, 1, 2, …).
 *  - `filteredConstraint`: IncompleteChord with only non-figurated notes that
 *                          start exactly at this beat — used for key detection.
 *  - `variants`:           All IncompleteChord combinations built from the
 *                          Cartesian product of the sub-beat notes for each
 *                          voice, both full (including figurated) and filtered.
 *                          The main analysis loop tries these in order.
 */
interface QuarterBeat {
  beatIndex: number;
  filteredConstraint: IncompleteChord;
  variants: IncompleteChord[];
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

/** Returns the Cartesian product of an array of option arrays. */
function cartesianProduct<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) {
    return [[]];
  }
  const [ first, ...rest ] = arrays;
  const restProduct = cartesianProduct(rest);
  return first.flatMap((item) => restProduct.map((combo) => [ item, ...combo ]));
}

@Injectable({ providedIn: 'root' })
export class HarmonyAnalysisService {
  /**
   * Runs roman-numeral analysis on a parsed chorale and stores the results
   * directly in each measure's `romanNumerals` array (aligned with bass notes).
   *
   * Algorithm:
   *  1. Build one QuarterBeat per quarter-note beat from the chorale.  For each
   *     beat, the `variants` array contains all IncompleteChord combinations
   *     derived from the Cartesian product of sub-beat note options for each
   *     voice (beat-boundary note vs. half-beat note), in both full (including
   *     figurated) and filtered (non-figurated) versions.
   *  2. Determine the home key by running a quick match-count for the parallel
   *     major and the relative minor using the filtered beat-boundary constraints;
   *     the scale with more successes is chosen.
   *  3. Walk through the quarter beats using a greedy longest-match pipeline:
   *       a. At each position, try every variant through matchingHarmony first
   *          WITHOUT modulation (canModulate=false), then WITH modulation as a
   *          fallback.  Among all passing results in the first MAX_SEARCH_RESULTS
   *          iterations, keep the one covering the most beats (longest match)
   *          provided the chord's actual bass note matches the constraint bass.
   *       b. On failure mark the current beat "?" and restart from the next.
   *  4. After analysis, confirm figuration labels: notes NOT in their surrounding
   *     chord(s) are confirmed non-chord tones (trailing "?" stripped); notes
   *     that ARE chord tones have their label cleared.
   */
  analyze(chorale: ParsedChorale): void {
    const beats = this.buildQuarterBeats(chorale);
    if (beats.length === 0) {
      return;
    }

    const scale = this.buildScale(chorale, beats.map((b) => b.filteredConstraint));

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

    while (position < beats.length) {
      const remaining = beats.slice(position);

      let bestChords: { romanNumeral: RomanNumeral }[] | null = null;
      let bestApplied = Infinity; // Applied-chord count in best result (fewer is better).
      let bestLen = 0;
      let bestNext: RomanNumeral = tonicRN;

      /**
       * Compare a candidate match using the scoring criteria from the problem
       * statement: prefer fewest applied chords first, then prefer longest
       * sequence (most beats covered).
       *
       *  Primary:   applied-chord count  (lower  is better)
       *  Secondary: sequence length      (higher is better)
       */
      const isBetter = (chords: { romanNumeral: RomanNumeral }[]): boolean => {
        const applied = chords.filter((c) => c.romanNumeral?.applied !== null).length;
        if (applied < bestApplied) {
          return true;
        }
        if (applied === bestApplied && chords.length > bestLen) {
          return true;
        }
        return false;
      };

      // Strategy: try without modulation first (prevents false key changes from
      // spuriously long modulated paths); fall back to canModulate=true only
      // when the non-modulating pass finds nothing.
      for (const canModulate of [ false, true ]) {
        if (bestLen > 0) {
          break;
        }
        const harmonizer = new Harmonizer({ canModulate });

        // Try each note-combination variant for the leading beat.
        // The variants cover both full (figurated-inclusive) and filtered
        // (non-figurated) combinations; they are tried in the order built by
        // buildQuarterBeats (full before filtered, more notes before fewer).
        //
        // vi = 0: use filteredConstraint (non-figurated beat-boundary notes) for
        //         ALL positions — this matches the original single-constraint-per-beat
        //         behaviour.  Length is capped at 1 to prevent the harmonizer from
        //         greedily extending a sequence when most constraints are all-undefined
        //         (which would happen when figuration detection marks everything at a
        //         beat as non-chord tones).
        // vi > 0: try a specific note-combination variant for the FIRST position while
        //         using variants[0] (full notes, may include figurated) for subsequent
        //         positions so the bass filter works correctly in multi-beat matches.
        //         Allows length > 1 to pick up chord expansions (V43 → i6, etc.).
        const variantCount = remaining[0].variants.length;
        for (let vi = 0; vi < variantCount; vi++) {
          const constraints = remaining.map((qb, idx) => {
            if (vi === 0) {
              // Baseline pass: pure filtered constraints everywhere.
              return qb.filteredConstraint;
            }
            // Enhanced pass: specific variant for first beat, full variant for rest.
            return idx === 0 ? qb.variants[vi] : (qb.variants[0] ?? qb.filteredConstraint);
          });

          // For the baseline pass only look at single-beat results to avoid
          // consuming beats with spuriously long all-same-chord sequences.
          const maxLen = vi === 0 ? 1 : MAX_SEARCH_RESULTS;

          try {
            let iterations = 0;
            for (const [ chords, next ] of harmonizer.matchingHarmony(constraints, 0, prevRN)) {
              if (chords.length <= maxLen
                && this.passesBassFilter(chords, constraints)
                && isBetter(chords)) {
                bestApplied = chords.filter((c) => c.romanNumeral?.applied !== null).length;
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
            break;
          }
        }
      }

      if (bestChords !== null) {
        for (let i = 0; i < bestLen; i++) {
          const beat = beats[position + i];
          if (beat !== undefined) {
            const rn = this.relabelForBass(bestChords[i]?.romanNumeral, i === 0
              ? (remaining[0].variants[0] ?? remaining[0].filteredConstraint)
              : (remaining[i]?.variants[0] ?? remaining[i]?.filteredConstraint));
            if (rn) {
              romanByBeat.set(beat.beatIndex, toRomanNumeralAnalysis(rn));
              if ((beat.filteredConstraint.voices ?? []).some((v) => v !== undefined)) {
                chordByBeat.set(beat.beatIndex, rn);
              }
            }
          }
        }
        position += bestLen;
        prevRN = bestNext;
      } else {
        // Cannot harmonize this beat — mark as unknown and restart from next.
        romanByBeat.set(beats[position].beatIndex, null);
        prevRN = tonicRN;
        position++;
      }
    }

    this.applyToMeasures(chorale, romanByBeat);
    this.confirmFigurations(chorale, chordByBeat);
  }

  /**
   * Returns true when every chord in the sequence satisfies:
   *  1. All defined constraint voices appear in the chord's note set.
   *  2. The constraint bass voice (`voices[3]`) appears somewhere in the chord's
   *     note set (any inversion).  Actual inversion is resolved by relabelForBass.
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
      const voices = constraints[i]?.voices ?? [];
      const rnNoteNames = new Set(rn.notes.map((n) => n.simpleName));

      // All defined constraint voices must appear in the chord's note set.
      for (const v of voices) {
        if (v !== null && v !== undefined && !rnNoteNames.has(v.simpleName)) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * Given a RomanNumeral from the harmonizer and the constraint for that beat,
   * returns the same chord relabelled to the inversion that places the constraint
   * bass note (`voices[3]`) at the bass position.  If the bass note is not in
   * the chord, or there is no bass constraint, the original is returned unchanged.
   */
  private relabelForBass(
    rn: RomanNumeral | undefined,
    constraint: IncompleteChord | undefined,
  ): RomanNumeral | undefined {
    if (!rn) {
      return undefined;
    }
    const bassNote = constraint?.voices?.[3];
    if (!bassNote) {
      return rn;
    }
    const invIdx = rn.notes.findIndex((n) => n.simpleName === bassNote.simpleName);
    if (invIdx < 0 || invIdx === rn.inversion) {
      return rn;
    }
    // Re-create the RomanNumeral with the correct inversion.
    try {
      return rn.with({ inversion: invIdx });
    } catch {
      return rn;
    }
  }

  /**
   * Builds one QuarterBeat per quarter-note beat.
   *
   * For each voice, notes that start within the quarter-note window
   * [beat, beat+1) are collected as options (beat-boundary note and/or
   * half-beat note).  The Cartesian product of all voice options is then
   * expanded into IncompleteChord variants, covering both full (figurated
   * notes included) and filtered (figurated notes replaced by undefined)
   * versions.  Duplicate chords are deduplicated.
   *
   * The `filteredConstraint` field contains only non-figurated notes that
   * start EXACTLY at the beat boundary — this is used for key detection and
   * matches the previous single-constraint-per-beat behaviour.
   */
  private buildQuarterBeats(chorale: ParsedChorale): QuarterBeat[] {
    // beatIndex → voice index → list of {note, figurated}
    const beatVoiceNotes = new Map<number, VoiceNote[][]>();

    const getOrCreate = (key: number): VoiceNote[][] => {
      if (!beatVoiceNotes.has(key)) {
        beatVoiceNotes.set(key, [[], [], [], []]);
      }
      return beatVoiceNotes.get(key)!;
    };

    // beatIndex → voice index → {note, figurated} at the exact beat boundary
    const onBeatNotes = new Map<number, (VoiceNote | undefined)[]>();

    const getOrCreateOnBeat = (key: number): (VoiceNote | undefined)[] => {
      if (!onBeatNotes.has(key)) {
        onBeatNotes.set(key, [ undefined, undefined, undefined, undefined ]);
      }
      return onBeatNotes.get(key)!;
    };

    let measureStart = 0;

    for (const measure of chorale.measures) {
      for (let partIdx = 0; partIdx < Math.min(measure.partNotes.length, 4); partIdx++) {
        let partBeat = measureStart;
        for (const n of (measure.partNotes[partIdx] ?? [])) {
          if (n.note) {
            const beatIndex = Math.floor(partBeat + EPS);
            const voiceNote: VoiceNote = { note: n.note, figurated: !!n.figuration };
            getOrCreate(beatIndex)[partIdx].push(voiceNote);

            // Track exact beat-boundary notes for filteredConstraint / key detection.
            if (Math.abs(partBeat - beatIndex) < EPS) {
              getOrCreateOnBeat(beatIndex)[partIdx] = voiceNote;
            }
          }
          partBeat += vexToBeat(n.vexDuration);
        }
      }
      for (const n of (measure.partNotes[0] ?? [])) {
        measureStart += vexToBeat(n.vexDuration);
      }
    }

    const allKeys = new Set([ ...beatVoiceNotes.keys(), ...onBeatNotes.keys() ]);
    return Array.from(allKeys)
      .sort((a, b) => a - b)
      .map((beatIndex) => {
        const perVoice = beatVoiceNotes.get(beatIndex) ?? [[], [], [], []];
        const onBeat = onBeatNotes.get(beatIndex) ?? [ undefined, undefined, undefined, undefined ];

        // filteredConstraint: non-figurated beat-boundary notes only.
        const filteredVoices = onBeat.map((vn) => vn !== undefined && !vn.figurated ? vn.note : undefined,
        );
        const filteredConstraint = new IncompleteChord({ voices: filteredVoices });

        // Build variants via Cartesian product of per-voice note options.
        // Each voice contributes: its notes collected above, plus undefined
        // (allows a voice to be unconstrained).
        const voiceOptions: (import('harmony-ts').AbsoluteNote | undefined)[][] =
          perVoice.map((notes) => {
            if (notes.length === 0) {
              return [ undefined ];
            }
            // Unique notes + undefined option (unconstrained).
            const seen = new Set<string>();
            const opts: (import('harmony-ts').AbsoluteNote | undefined)[] = [];
            for (const vn of notes) {
              if (!seen.has(vn.note.simpleName)) {
                seen.add(vn.note.simpleName);
                opts.push(vn.note);
              }
            }
            opts.push(undefined);
            return opts;
          });

        const combos = cartesianProduct(voiceOptions);

        // Build IncompleteChord for each combo; also build a filtered version
        // (figurated notes replaced by undefined) and add it if distinct.
        const seenKeys = new Set<string>();
        const variants: IncompleteChord[] = [];

        const addVariant = (voices: (import('harmony-ts').AbsoluteNote | undefined)[]) => {
          const key = voices.map((v) => v?.simpleName ?? '_').join(',');
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            variants.push(new IncompleteChord({ voices }));
          }
        };

        for (const combo of combos) {
          // Full variant (may include figurated notes).
          addVariant(combo);

          // Filtered variant: replace figurated notes with undefined.
          const filtered = combo.map((note, vi) => {
            if (!note) {
              return undefined;
            }
            const match = perVoice[vi].find((vn) => vn.note === note);
            return match?.figurated ? undefined : note;
          });
          addVariant(filtered);
        }

        return { beatIndex, filteredConstraint, variants };
      });
  }

  /**
   * Convert keyFifths + isMinor into a harmony-ts Scale tuple.
   *
   * When the MusicXML does not specify `<mode>minor`, both the parallel major
   * (keyFifths) and the relative minor (keyFifths + 3) are tried against the
   * opening constraints.  Whichever yields more successful bass-anchored matches
   * in the first KEY_DETECT_BEATS beats is chosen as the home key.
   *
   * Additionally, if the first bass note matches the relative-minor tonic and
   * ≥ 3 voices are defined at the opening beat, the minor scale is preferred
   * directly (avoids false ties when figurations make many beats ambiguous).
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

    // Heuristic: if the opening bass note matches the relative-minor tonic and
    // at least 3 voices are defined (to reduce false positives), immediately
    // prefer the minor scale without running the full count-based detection.
    // This handles the common case where figuration detection makes many beats
    // ambiguous between the relative major and minor.
    const firstConstraint = constraints[0];
    if (firstConstraint) {
      const bassNote = firstConstraint.voices?.[3];
      const voiceCount = (firstConstraint.voices ?? []).filter((v) => v !== undefined).length;
      if (bassNote && voiceCount >= 3) {
        const minorTonicRN = new RomanNumeral(
          { scaleDegree: ScaleDegree.TONIC, quality: ChordQuality.MINOR },
          minorScale,
        );
        if (bassNote.simpleName === minorTonicRN.root?.simpleName) {
          return minorScale;
        }
      }
    }

    const majorCount = this.countQuickMatches(constraints, majorScale);
    const minorCount = this.countQuickMatches(constraints, minorScale);
    return minorCount > majorCount ? minorScale : majorScale;
  }

  /**
   * Quick key-detection pass: counts how many of the first KEY_DETECT_BEATS
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

    const checkCount = Math.min(constraints.length, KEY_DETECT_BEATS);
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
   * A bass note that starts exactly on a quarter-note boundary gets the roman
   * numeral label for that beat.  A beat that was attempted but failed analysis
   * is rendered as "?".
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
   *   the chord(s) at the surrounding quarter-note beats.
   * - If the note's pitch is NOT in any surrounding chord → confirmed
   *   non-chord tone: remove the trailing "?".
   * - If the note's pitch IS in a surrounding chord → clear the label entirely
   *   (the figuration detector mis-classified it as non-harmonic).
   * - If no chord data is available, the tentative label is left unchanged.
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

    // Check the chord at both enclosing quarter-note beats (floor and ceil).
    const floorBeat = Math.floor(partBeat);
    const ceilBeat = Math.ceil(partBeat);
    const beatsToCheck = [ ...new Set([ floorBeat, ceilBeat ]) ];

    const noteName = n.note.simpleName;
    let hasChordData = false;
    let isChordTone = false;

    for (const beat of beatsToCheck) {
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
      return;
    }

    if (isChordTone) {
      n.figuration = null;
    } else {
      n.figuration = n.figuration.replace(/\?$/, '');
    }
  }
}
