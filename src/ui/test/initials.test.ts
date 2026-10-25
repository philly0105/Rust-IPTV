// The two letters on fallback tiles: posters and source marks (initialsOf) and channel monograms
// (monogramText). Provider tags, quality and copy markers and the punctuation around words never
// become an initial.
import { describe, expect, it } from 'vitest';

import { monogramText } from '@/features/live/lib/monogram';
import { initialsOf } from '@/ui/Poster';

describe('fallback initials', () => {
  it('take the first letters of the first two words, or one word\'s first two', () => {
    expect(initialsOf('Black Hole')).toBe('BH');
    expect(initialsOf('The Gamma Ray')).toBe('GR');
    expect(initialsOf('Riverside')).toBe('RI');
    expect(initialsOf('X-Men')).toBe('XM');
    expect(initialsOf("Ocean's Eleven")).toBe('OE');
    expect(initialsOf('6 month')).toBe('6M');
    expect(initialsOf('')).toBe('?');
  });

  it('skip a provider tag, quality and copy markers, and punctuation', () => {
    expect(initialsOf('US| ESPN HD')).toBe('ES');
    expect(initialsOf('US: FOX NEWS HD')).toBe('FN');
    // Three letters before a colon may start a title ("CSI: Miami"), so they stay.
    expect(initialsOf('NBA: BOSTON CELTICS ᴴᴰ')).toBe('NB');
    expect(initialsOf('US| CBS (Backup)')).toBe('CB');
    expect(initialsOf('[DE] Das Erste')).toBe('DE');
    expect(initialsOf('Night Portal HD')).toBe('NP');
    // A name of markers only keeps them.
    expect(initialsOf('HD')).toBe('HD');
    // Pipes and plus signs are no initials; a title with a colon keeps its first word.
    expect(initialsOf('|EN| The Matrix')).toBe('EM');
    expect(initialsOf('4K | Dune')).toBe('DU');
    expect(initialsOf('IPTV | Main')).toBe('IM');
    expect(initialsOf('CSI: Miami')).toBe('CM');
    expect(initialsOf('1917')).toBe('19');
  });

  it('channel monograms read names the same way, and keep whole code points', () => {
    expect(monogramText('UK: BBC One HD')).toBe('BO');
    expect(monogramText('US| ESPN ᴴᴰ')).toBe('ES');
    expect(monogramText('US| CBS (Backup)')).toBe('CB');
    // A family's numbered channels keep apart.
    expect(monogramText('US| FS1 4K')).toBe('F1');
    expect(monogramText('US| ESPN2 FHD')).toBe('E2');
    expect(monogramText('US| ESPN HD')).toBe('ES');
    expect(monogramText('M6')).toBe('M6');
    expect(monogramText('Sport 1')).toBe('S1');
    expect(monogramText('Meridian News HD')).toBe('MN');
    // A per-game channel takes one letter of each team, past its slot number and kickoff time.
    expect(monogramText('NFL 03: Cleveland Browns vs Tennessee Titans @ 1:00 PM ET')).toBe('CT');
    expect(monogramText('NFL  | 03 - 1pm 49ers at Falcons')).toBe('4F');
    expect(monogramText('NBA 05: Celtics vs Knicks')).toBe('CK');
    // A name with "at" in it but no matchup keeps its own initials.
    expect(monogramText('Art at Home')).toBe('AH');
    // A letter outside the Basic Multilingual Plane and an emoji stay whole.
    expect(monogramText('𠀀 Beta')).toBe('𠀀B');
    expect(monogramText('🏈 Sunday Football')).toBe('🏈S');
  });
});
