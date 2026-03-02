import { describe, expect, it, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AbsoluteNote } from 'harmony-ts';
import { classifyFiguration, isSubBeat } from './figuration-detector';
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

  it('does not label quarter notes as figuration', () => {
    const result = service.parse(PASSING_TONE_XML);
    const sopranoNotes = result.measures[0].partNotes[0];
    expect(sopranoNotes[0].figuration).toBeFalsy();
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
});

