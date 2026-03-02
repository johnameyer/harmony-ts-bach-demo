import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AbsoluteNote } from 'harmony-ts';
import { classifyFiguration, classifySuspension, isSubBeat } from './figuration-detector';
import { MusicXmlParserService } from './music-xml-parser.service';

function note(name: string): AbsoluteNote {
  return AbsoluteNote.fromString(name);
}

describe('isSubBeat', () => {
  it('returns false for quarter note', () => expect(isSubBeat('q')).toBe(false));
  it('returns false for half note', () => expect(isSubBeat('h')).toBe(false));
  it('returns false for whole note', () => expect(isSubBeat('w')).toBe(false));
  it('returns false for dotted quarter note', () => expect(isSubBeat('qd')).toBe(false));
  it('returns false for dotted half note', () => expect(isSubBeat('hd')).toBe(false));
  it('returns true for eighth note', () => expect(isSubBeat('8')).toBe(true));
  it('returns true for 16th note', () => expect(isSubBeat('16')).toBe(true));
  it('returns true for dotted eighth note', () => expect(isSubBeat('8d')).toBe(true));
});

describe('classifyFiguration', () => {
  it('returns null when both prev and next are missing', () => {
    expect(classifyFiguration(note('D4'), null, null)).toBeNull();
  });

  it('returns null when only prev is provided', () => {
    expect(classifyFiguration(note('D4'), note('C4'), null)).toBeNull();
  });

  it('returns null when only next is provided', () => {
    expect(classifyFiguration(note('D4'), null, note('E4'))).toBeNull();
  });

  describe('passing tone (P?)', () => {
    it('detects ascending passing tone (C–D–E)', () => {
      expect(classifyFiguration(note('D4'), note('C4'), note('E4'))).toBe('P?');
    });

    it('detects descending passing tone (E–D–C)', () => {
      expect(classifyFiguration(note('D4'), note('E4'), note('C4'))).toBe('P?');
    });
  });

  describe('neighbor note (N?)', () => {
    it('detects upper neighbor (C–D–C)', () => {
      expect(classifyFiguration(note('D4'), note('C4'), note('C4'))).toBe('N?');
    });

    it('detects lower neighbor (E–D–E)', () => {
      expect(classifyFiguration(note('D4'), note('E4'), note('E4'))).toBe('N?');
    });
  });

  describe('escape tone (ET?)', () => {
    it('detects escape tone – step approach, skip departure (C–D–F)', () => {
      expect(classifyFiguration(note('D4'), note('C4'), note('F4'))).toBe('ET?');
    });
  });

  describe('appogiatura (App?)', () => {
    it('detects appogiatura – skip approach, step departure (C–E–D)', () => {
      expect(classifyFiguration(note('E4'), note('C4'), note('D4'))).toBe('App?');
    });
  });

  describe('chordal skip (CS?)', () => {
    it('detects chordal skip – skip approach and departure (C–E–G)', () => {
      expect(classifyFiguration(note('E4'), note('C4'), note('G4'))).toBe('CS?');
    });
  });

  describe('anticipation (Ant?)', () => {
    it('detects anticipation – sub-beat note matches the next note (C–E–E)', () => {
      expect(classifyFiguration(note('E4'), note('C4'), note('E4'))).toBe('Ant?');
    });

    it('does not flag as anticipation when prev also matches (E–E–E)', () => {
      // All three same → not an anticipation (prev matches current so it's just a repeated note)
      expect(classifyFiguration(note('E4'), note('E4'), note('E4'))).toBeNull();
    });
  });
});

describe('classifySuspension', () => {
  it('returns null when prev is missing', () => {
    expect(classifySuspension(note('D4'), null, note('C4'))).toBeNull();
  });

  it('returns null when next is missing', () => {
    expect(classifySuspension(note('D4'), note('D4'), null)).toBeNull();
  });

  it('returns null when pitch does not repeat from previous', () => {
    expect(classifySuspension(note('D4'), note('E4'), note('C4'))).toBeNull();
  });

  it('returns null when pitch repeats but resolves by skip', () => {
    expect(classifySuspension(note('D4'), note('D4'), note('B3'))).toBeNull();
  });

  it('returns null when pitch repeats but resolves to the same note (unison)', () => {
    expect(classifySuspension(note('D4'), note('D4'), note('D4'))).toBeNull();
  });

  it('detects suspension – same pitch as prev, step resolution down (D–D–C)', () => {
    expect(classifySuspension(note('D4'), note('D4'), note('C4'))).toBe('Sus?');
  });

  it('detects suspension – same pitch as prev, step resolution up (D–D–E)', () => {
    expect(classifySuspension(note('D4'), note('D4'), note('E4'))).toBe('Sus?');
  });
});

describe('MusicXmlParserService figuration integration', () => {
  let service: MusicXmlParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MusicXmlParserService);
  });

  const PASSING_TONE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Figuration Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

  it('does not label quarter notes as figuration when pitches differ', () => {
    const result = service.parse(PASSING_TONE_XML);
    const sopranoNotes = result.measures[0].partNotes[0];
    // C4 quarter: no previous note → no Sus?
    expect(sopranoNotes[0].figuration).toBeFalsy();
    // F4 quarter: previous E4 ≠ F4 → no Sus?
    expect(sopranoNotes[3].figuration).toBeFalsy();
  });

  it('labels eighth notes as ascending passing tones when in stepwise ascending context', () => {
    const result = service.parse(PASSING_TONE_XML);
    const sopranoNotes = result.measures[0].partNotes[0];
    // D4 eighth: C→D→E = ascending passing tone
    expect(sopranoNotes[1].figuration).toBe('P?');
    // E4 eighth: D→E→F = ascending passing tone
    expect(sopranoNotes[2].figuration).toBe('P?');
  });

  const SUSPENSION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Suspension Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions></attributes>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`;

  it('labels repeated quarter note resolving by step as suspension', () => {
    const result = service.parse(SUSPENSION_XML);
    const notes = result.measures[0].partNotes[0];
    // First D4: no prev → no Sus?
    expect(notes[0].figuration).toBeFalsy();
    // Second D4: prev=D4, next=C4 (step down) → Sus?
    expect(notes[1].figuration).toBe('Sus?');
    // C4: prev=D4, not a repeated note → no Sus?
    expect(notes[2].figuration).toBeFalsy();
  });

  const ANTICIPATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Anticipation Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

  it('labels sub-beat note matching next quarter pitch as anticipation', () => {
    const result = service.parse(ANTICIPATION_XML);
    const notes = result.measures[0].partNotes[0];
    // C4 quarter: first note, no figuration
    expect(notes[0].figuration).toBeFalsy();
    // E4 eighth: prev=C4, next=E4 (same pitch) → Ant?
    expect(notes[1].figuration).toBe('Ant?');
    // E4 quarter: not sub-beat, prev=E4 (same) and next=null → no Sus? (no next)
    expect(notes[2].figuration).toBeFalsy();
  });
});

