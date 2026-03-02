import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeAll } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CHORALE_FILES } from '../data/chorales-list.generated';
import { MusicXmlParserService } from './music-xml-parser.service';

const CHORALES_DIR = join(
  process.cwd(),
  'node_modules/Bach_chorale_FB/FB_source/musicXML_master',
);

describe('MusicXmlParserService – all chorales', () => {
  let service: MusicXmlParserService;

  beforeAll(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MusicXmlParserService);
  });

  it('should have a non-empty chorales list', () => {
    expect(CHORALE_FILES.length).toBeGreaterThan(0);
  });

  for (const filename of CHORALE_FILES) {
    it(`parses ${filename}`, () => {
      const xml = readFileSync(join(CHORALES_DIR, filename), 'utf8');
      const result = service.parse(xml);

      expect(result.beats.length).toBeGreaterThan(0);
      expect(result.partNames.length).toBeGreaterThan(0);
      expect(result.title).toBeTruthy();

      // Every beat slot should have exactly one entry per part
      for (const beat of result.beats) {
        expect(beat.length).toBe(result.partNames.length);
      }
    });
  }
});
