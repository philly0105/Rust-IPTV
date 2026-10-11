import { describe, expect, it } from 'vitest';

import { REDACTED, redactText, redactUrl } from '../lib/redact';

describe('redactUrl', () => {
  it('hides the Xtream XMLTV password and keeps the rest', () => {
    expect(redactUrl('http://xt.example.com:8080/xmltv.php?username=alice&password=s3cr3t')).toBe(
      `http://xt.example.com:8080/xmltv.php?username=alice&password=${REDACTED}`,
    );
  });

  it('handles the password first, encoded values, and fragments', () => {
    expect(redactUrl('http://h/xmltv.php?password=a%26b&username=u')).toBe('http://h/xmltv.php?password=***&username=u');
    expect(redactUrl('http://h/x?user=u#password=zz')).toBe('http://h/x?user=u#password=***');
  });

  it('is case-insensitive and covers common secret names', () => {
    expect(redactUrl('http://h/x?PASSWORD=1&Token=2&pwd=3&api_key=4')).toBe('http://h/x?PASSWORD=***&Token=***&pwd=***&api_key=***');
  });

  it('does not touch parameters that only end with a secret name', () => {
    expect(redactUrl('http://h/x?nopassword=1&monkey=2')).toBe('http://h/x?nopassword=1&monkey=2');
  });

  it('removes everything in the userinfo', () => {
    expect(redactUrl('https://bob:hunter2@epg.example.com/guide.xml.gz')).toBe('https://***@epg.example.com/guide.xml.gz');
    expect(redactUrl('https://token@epg.example.com/g.xml')).toBe('https://***@epg.example.com/g.xml');
    expect(redactUrl('http://a:b@c@h/x?password=p')).toBe('http://***@h/x?password=***');
  });

  it('leaves an @ in the path or query alone', () => {
    expect(redactUrl('http://h/users/a@b.com/list.xml')).toBe('http://h/users/a@b.com/list.xml');
  });

  it('keeps an empty password parameter empty', () => {
    expect(redactUrl('http://h/xmltv.php?username=u&password=')).toBe('http://h/xmltv.php?username=u&password=');
  });

  it('returns non-URLs and clean URLs unchanged', () => {
    expect(redactUrl('')).toBe('');
    expect(redactUrl('not a url')).toBe('not a url');
    expect(redactUrl('https://epg.example/guide.xml.gz')).toBe('https://epg.example/guide.xml.gz');
  });
});

describe('redactText', () => {
  it('redacts every URL in a message', () => {
    expect(
      redactText('GET http://h/xmltv.php?username=u&password=p failed; retry https://x:y@h2/a?token=t later'),
    ).toBe('GET http://h/xmltv.php?username=u&password=*** failed; retry https://***@h2/a?token=*** later');
  });

  it('passes through empty input', () => {
    expect(redactText(undefined)).toBe('');
    expect(redactText(null)).toBe('');
    expect(redactText('plain')).toBe('plain');
  });
});
