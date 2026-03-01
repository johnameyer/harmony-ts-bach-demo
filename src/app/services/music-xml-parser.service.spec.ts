import { TestBed } from '@angular/core/testing';
import { Accidental } from 'harmony-ts';
import { MusicXmlParserService } from './music-xml-parser.service';

const SIMPLE_MUSICXML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Test Chorale</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Soprano</part-name></score-part>
    <score-part id="P2"><part-name>Bass</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>4</duration><type>half</type></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>2</divisions></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>8</duration><type>whole</type></note>
    </measure>
  </part>
</score-partwise>`;

describe('MusicXmlParserService', () => {
  let service: MusicXmlParserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MusicXmlParserService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('parse', () => {
    it('should extract the title', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      expect(result.title).toBe('Test Chorale');
    });

    it('should extract part names', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      expect(result.partNames).toEqual([ 'Soprano', 'Bass' ]);
    });

    it('should produce the correct number of beat slots', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      expect(result.beats.length).toBe(4);
    });

    it('should have correct number of parts per beat', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      expect(result.beats[0].length).toBe(2);
    });

    it('should parse soprano quarter notes correctly', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      // Beat 0: G4 quarter note
      expect(result.beats[0][0].length).toBe(1);
      expect(result.beats[0][0][0].name).toBe('G4');
      // Beat 1: F4 quarter note
      expect(result.beats[1][0].length).toBe(1);
      expect(result.beats[1][0][0].name).toBe('F4');
    });

    it('should sustain soprano half note across two beats', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      // Eb4 half note covers beats 2 and 3
      expect(result.beats[2][0].length).toBe(1);
      expect(result.beats[2][0][0].name).toBe('Eb4');
      expect(result.beats[3][0].length).toBe(1);
      expect(result.beats[3][0][0].name).toBe('Eb4');
    });

    it('should sustain bass whole note across all four beats', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      for (let i = 0; i < 4; i++) {
        expect(result.beats[i][1].length).toBe(1);
        expect(result.beats[i][1][0].name).toBe('C3');
      }
    });

    it('should parse accidentals correctly', () => {
      const result = service.parse(SIMPLE_MUSICXML);
      const ebNote = result.beats[2][0][0];
      expect(ebNote.letterName).toBe('E');
      expect(ebNote.accidental).toBe(Accidental.FLAT);
      expect(ebNote.octavePosition).toBe(4);
    });
  });

  describe('parse with sub-beat notes', () => {
    const EIGHTH_NOTE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Eighth Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>1</duration><type>eighth</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

    it('should group two eighth notes in the same beat slot', () => {
      const result = service.parse(EIGHTH_NOTE_XML);
      expect(result.beats[0][0].length).toBe(2);
      expect(result.beats[0][0][0].name).toBe('C4');
      expect(result.beats[0][0][1].name).toBe('D4');
    });

    it('should put the quarter note in the next beat slot', () => {
      const result = service.parse(EIGHTH_NOTE_XML);
      expect(result.beats[1][0].length).toBe(1);
      expect(result.beats[1][0][0].name).toBe('E4');
    });
  });

  describe('parse with rest', () => {
    const REST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Rest Test</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Voice</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions></attributes>
      <note><rest/><duration>2</duration><type>quarter</type></note>
      <note><pitch><step>A</step><octave>4</octave></pitch><duration>2</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

    it('should leave beat slot empty for a rest', () => {
      const result = service.parse(REST_XML);
      expect(result.beats[0][0].length).toBe(0);
    });

    it('should place the note after the rest correctly', () => {
      const result = service.parse(REST_XML);
      expect(result.beats[1][0].length).toBe(1);
      expect(result.beats[1][0][0].name).toBe('A4');
    });
  });
});
