import { AbsoluteNote, ComplexInterval } from 'harmony-ts';

export type FigurationLabel = 'P?' | 'N?' | 'CS?' | 'ET?' | 'App?';

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
