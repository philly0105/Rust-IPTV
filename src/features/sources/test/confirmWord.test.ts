import { describe, expect, it } from 'vitest';

import { confirmWordMatches, foldConfirmWord } from '../lib/confirmWord';
import { importErrorCode, importSummaryKey } from '../lib/errors';

describe('remove-all confirmation word', () => {
  it('accepts the localized word without its diacritics, in any case, with spaces around', () => {
    expect(confirmWordMatches('usuń', 'usuń')).toBe(true);
    expect(confirmWordMatches('usun', 'usuń')).toBe(true);
    expect(confirmWordMatches('  USUŃ ', 'usuń')).toBe(true);
    expect(confirmWordMatches('διαγραφή', 'διαγραφή')).toBe(true);
    expect(confirmWordMatches('διαγραφη', 'διαγραφή')).toBe(true);
    expect(confirmWordMatches('ΔΙΑΓΡΑΦΗ', 'διαγραφή')).toBe(true);
    expect(confirmWordMatches('削除', '削除')).toBe(true);
    // Decomposed input (some IMEs and macOS paste) equals the precomposed word.
    expect(confirmWordMatches('usun\u0301', 'usuń')).toBe(true);
  });

  it('accepts the English word in every locale', () => {
    for (const word of ['usuń', 'διαγραφή', '削除', 'entfernen', 'remove']) {
      expect(confirmWordMatches('remove', word)).toBe(true);
      expect(confirmWordMatches('REMOVE', word)).toBe(true);
      expect(confirmWordMatches(' Remove ', word)).toBe(true);
    }
  });

  it('rejects anything else', () => {
    expect(confirmWordMatches('', 'usuń')).toBe(false);
    expect(confirmWordMatches('   ', 'remove')).toBe(false);
    expect(confirmWordMatches('usu', 'usuń')).toBe(false);
    expect(confirmWordMatches('削', '削除')).toBe(false);
    expect(confirmWordMatches('removed', '削除')).toBe(false);
    expect(foldConfirmWord(' Ünïcödé ')).toBe('unicode');
  });
});

describe('import error summaries', () => {
  it('classifies the core text into a translated summary key', () => {
    expect(importErrorCode('error sending request for url (http://127.0.0.1:7399/x.m3u)')).toBe('network');
    expect(importErrorCode('operation timed out')).toBe('timeout');
    expect(importErrorCode('upstream answered HTTP 401')).toBe('auth');
    expect(importErrorCode('HTTP 404 Not Found')).toBe('not_found');
    expect(importErrorCode('could not parse the playlist')).toBe('invalid');
    expect(importErrorCode(undefined)).toBe('internal');
    expect(importSummaryKey('something odd')).toBe('errorSummaryGeneric');
    expect(importSummaryKey('connection refused')).toBe('errorSummaryNetwork');
  });
});
