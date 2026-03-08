import { AbsoluteNote, ComplexInterval } from 'harmony-ts';

export type FigurationLabel = 'P?' | 'N?' | 'CS?' | 'ET?' | 'App?' | 'Ant?' | 'Sus?';

/**
 * Returns true if the VexFlow duration string represents a note shorter than a
 * quarter note (i.e. a candidate for non-harmonic / figuration status).
 */
export function isSubBeat(vexDuration: string): boolean {
  const base = vexDuration.replace(/d+$/, '');
  return [ '8', '16', '32', '64' ].includes(base);
}

/**
 * Returns the diatonic interval size (1 = unison, 2 = 2nd, 3 = 3rd, …) between
 * two absolute notes, always measured as the ascending compound interval.
 */
function getIntervalSize(from: AbsoluteNote, to: AbsoluteNote): number {
  if (from.midi === to.midi) {
    return 1;
  }
  const lower = from.midi < to.midi ? from : to;
  const higher = from.midi < to.midi ? to : from;
  try {
    const interval = new ComplexInterval(lower, higher);
    // ComplexInterval.complexSize returns 'U' for unison, otherwise a numeric string
    const sz = interval.complexSize;
    return sz === 'U' ? 1 : parseInt(sz, 10);
  } catch {
    return 999;
  }
}

/**
 * Classifies a sub-beat note as a potential figuration tone based on the
 * melodic motion from the previous pitch and to the next pitch.
 *
 * Returns one of:
 *  - 'Ant?' Anticipation   – same pitch as the next (strong-beat) note
 *  - 'P?'   Passing Tone  – stepwise approach and departure in the same direction
 *  - 'N?'   Neighbor Note – stepwise approach and departure in opposite directions
 *  - 'ET?'  Escape Tone   – stepwise approach, skip departure
 *  - 'App?' Appogiatura   – skip approach, stepwise departure
 *  - 'CS?'  Chordal Skip  – skip approach and departure
 *  - null   if context is insufficient for classification
 */
export function classifyFiguration(
  current: AbsoluteNote,
  prev: AbsoluteNote | null,
  next: AbsoluteNote | null,
): FigurationLabel | null {
  if (!prev || !next) {
    return null;
  }

  // Anticipation: arrives early on the pitch that the next strong-beat note will have
  if (next.midi === current.midi && prev.midi !== current.midi) {
    return 'Ant?';
  }

  const prevSize = getIntervalSize(prev, current);
  const nextSize = getIntervalSize(current, next);

  const prevStep = prevSize === 2;
  const nextStep = nextSize === 2;
  const prevSkip = prevSize >= 3;
  const nextSkip = nextSize >= 3;

  if (prevStep && nextStep) {
    const approachAscending = current.midi > prev.midi;
    const departureAscending = next.midi > current.midi;
    return approachAscending !== departureAscending ? 'N?' : 'P?';
  }
  if (prevStep && nextSkip) {
    return 'ET?';
  }
  if (prevSkip && nextStep) {
    return 'App?';
  }
  if (prevSkip && nextSkip) {
    return 'CS?';
  }

  return null;
}

/**
 * Classifies a non-sub-beat (quarter or longer) note as a potential suspension.
 *
 * A suspension holds the same pitch as the previous note into a new harmonic
 * context, appears in a metrically strong position, and resolves by step.
 *
 * Returns 'Sus?' when the pattern is detected, otherwise null.
 */
export function classifySuspension(
  current: AbsoluteNote,
  prev: AbsoluteNote | null,
  next: AbsoluteNote | null,
  currentBeatOffset?: number,
  nextBeatOffset?: number,
): FigurationLabel | null {
  if (!prev || !next) {
    return null;
  }
  if (prev.midi === current.midi && getIntervalSize(current, next) === 2) {
    // Check metrical strength: suspension must be on a strong beat, resolving to weaker.
    // Beats are 0-indexed (0=beat1, 1=beat2, 2=beat3, 3=beat4) with fractional subdivisions.
    // Strength metric: use integer beat for strength, but keep fractional for range checking.
    if (currentBeatOffset !== undefined && nextBeatOffset !== undefined) {
      const currentBeat = Math.floor(currentBeatOffset);
      const nextBeat = Math.floor(nextBeatOffset);
      
      // Calculate strength using bit operations on integer beat
      const currentStrength = (currentBeat & 1) * 2 + ((currentBeat >> 1) & 1);
      const nextStrength = (nextBeat & 1) * 2 + ((nextBeat >> 1) & 1);
      
      // Current beat must be strong (even: beats 0,2)
      if (currentBeat & 1) {
        return null;
      }
      
      // If next is in a later measure (nextBeat < currentBeat), suspension can cross measures
      // If same or earlier measure, next must be weaker than current
      // Strength values: 0 (strongest), 1, 2, 3 (weakest)
      // Reject if currentStrength > nextStrength (i.e., next is stronger or equal)
      if (nextBeat > currentBeat && currentStrength > nextStrength) {
        return null;
      }
    }
    return 'Sus?';
  }
  return null;
}
