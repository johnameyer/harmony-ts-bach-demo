import { Pipe, PipeTransform } from '@angular/core';

/** Converts a MusicXML filename like "BWV_102.07_FB.musicxml" → "BWV 102.07" */
@Pipe({ name: 'choraleLabel' })
export class ChoraleLabelPipe implements PipeTransform {
  transform(filename: string): string {
    return filename
      .replace(/_FB\.musicxml$/, '')
      .replace(/_/g, ' ');
  }
}
