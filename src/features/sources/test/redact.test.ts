import { describe, expect, it } from 'vitest';

import { REDACTED, redactText, redactUrl } from '../lib/redact';

describe('redactUrl', () => {
  it('hides the Xtream XMLTV login and keeps the rest', () => {
    expect(redactUrl('http://xt.example.com:8080/xmltv.php?username=alice&password=s3cr3t')).toBe(
      `http://xt.example.com:8080/xmltv.php?username=${REDACTED}&password=${REDACTED}`,
    );
  });

  it('hides Xtream credentials in stream paths', () => {
    expect(redactUrl('http://xt.example.com:8080/live/alice/s3cr3t/1234.ts')).toBe('http://xt.example.com:8080/live/***/***/1234.ts');
    expect(redactUrl('http://xt.example.com/movie/alice/s3cr3t/99.mkv')).toBe('http://xt.example.com/movie/***/***/99.mkv');
    expect(redactUrl('http://xt.example.com/series/alice/s3cr3t/7.mp4')).toBe('http://xt.example.com/series/***/***/7.mp4');
    expect(redactUrl('http://xt.example.com/timeshift/alice/s3cr3t/60/2026-10-11:20-00/5.ts')).toBe(
      'http://xt.example.com/timeshift/***/***/60/2026-10-11:20-00/5.ts',
    );
    expect(redactUrl('http://xt.example.com:8080/alice/s3cr3t/1234.ts')).toBe('http://xt.example.com:8080/***/***/1234.ts');
    expect(redactUrl('http://xt.example.com:8080/alice/s3cr3t/1234.m3u8?x=1')).toBe('http://xt.example.com:8080/***/***/1234.m3u8?x=1');
  });

  it('leaves ordinary paths alone', () => {
    expect(redactUrl('http://cdn.example.com/a/b/index.m3u8')).toBe('http://cdn.example.com/a/b/index.m3u8');
    expect(redactUrl('http://cdn.example.com/x/a/b/1234.ts')).toBe('http://cdn.example.com/x/a/b/1234.ts');
    expect(redactUrl('http://h/live.m3u')).toBe('http://h/live.m3u');
  });

  it('handles the password first, encoded values, and fragments', () => {
    expect(redactUrl('http://h/xmltv.php?password=a%26b&username=u')).toBe('http://h/xmltv.php?password=***&username=***');
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
    expect(redactUrl('http://h/xmltv.php?username=u&password=')).toBe('http://h/xmltv.php?username=***&password=');
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
    ).toBe('GET http://h/xmltv.php?username=***&password=*** failed; retry https://***@h2/a?token=*** later');
  });

  it('passes through empty input', () => {
    expect(redactText(undefined)).toBe('');
    expect(redactText(null)).toBe('');
    expect(redactText('plain')).toBe('plain');
  });
});
