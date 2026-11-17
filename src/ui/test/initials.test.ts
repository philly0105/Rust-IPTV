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
    expect(initialsOf('|EN| The Matrix')).toBe('MA');
    expect(initialsOf('4K | Dune')).toBe('DU');
    expect(initialsOf('IPTV | Main')).toBe('IM');
    expect(initialsOf('CSI: Miami')).toBe('CM');
    expect(initialsOf('1917')).toBe('19');
    expect(initialsOf('S01E01')).toBe('S0');
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
    expect(monogramText('NFL 05: 1 PM Bears at Packers')).toBe('BP');
    // A side of quality markers is no team: the name keeps its own initials.
    expect(monogramText('Channel V HD')).toBe('CV');
    expect(monogramText('Planet X 4K')).toBe('PX');
    // A letter outside the Basic Multilingual Plane and an emoji stay whole.
    expect(monogramText('𠀀 Beta')).toBe('𠀀B');
    // A leading emoji is decoration: the name's own letters.
    expect(monogramText('🏈 Sunday Football')).toBe('SF');
    expect(monogramText('⚽ ESPNU')).toBe('ES');
  });

  it('channel monograms skip what providers put before the name, and number empty slots', () => {
    expect(monogramText('CA EN: SKY SPORTS F1')).toBe('SS');
    expect(monogramText('PRIME: PBS HD')).toBe('PB');
    // A feed's backup number is no initial: siblings share the station's letters (w-realdata-10).
    expect(monogramText('PRIME: PBS HD (BACKUP 2)')).toBe('PB');
    expect(monogramText('BLOOMBERG HD (BACKUP 2)')).toBe('BL');
    expect(monogramText('BBC 2')).toBe('B2');
    expect(monogramText('PRIME: 🎬 ARD SD')).toBe('AR');
    expect(monogramText('US (ESPN+ 002) | Chelsea vs. Knicks (Matchday #25) Nov 17 02:00AM ET')).toBe('CK');
    expect(monogramText('NEXT | HAWKS VS ARSENAL | Tue 17 Nov 23:00 EDT (US)')).toBe('HA');
    expect(monogramText('ENDED | AUCKLAND FC VS BAYERN MUNICH | Mon 16 Nov')).toBe('AB');
    expect(monogramText('Bulls vs Knicks @ Nov 16 06:00 AM :NCAAB  19')).toBe('BK');
    expect(monogramText('- NO EVENT STREAMING - | 8K EXCLUSIVE | US: ESPN+ PPV 2')).toBe('2');
    expect(monogramText(':NCAAB  01')).toBe('01');
    expect(monogramText('MLB 05 :')).toBe('05');
    // A channel named with a number is no slot.
    expect(monogramText('ESPN 2')).toBe('E2');
  });
});
