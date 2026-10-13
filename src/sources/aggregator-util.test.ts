import { describe, expect, test } from 'bun:test';
import { htmlToText, toMillis, matchesAny, titleMatchesKeywords, postingMatchesKeywords, decodeEntities, sleep } from './aggregator-util';

describe('htmlToText', () => {
  test('strips tags and decodes common entities', () => {
    expect(htmlToText('<p>Hello&nbsp;&amp; <b>world</b></p>')).toBe('Hello & world');
  });

  test('turns block tags into newlines', () => {
    expect(htmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
  });

  test('drops script/style content', () => {
    expect(htmlToText('keep<script>evil()</script><style>x{}</style>ok')).toBe('keep ok');
  });

  test('caps to the given length', () => {
    expect(htmlToText('x'.repeat(100), 10)).toHaveLength(10);
  });

  test('returns empty string for nullish input', () => {
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(null)).toBe('');
  });

  test('strips tags hidden behind entity-escaped HTML (Arbeitnow/RemoteOK shape)', () => {
    // The description's own HTML markup is itself HTML-entity-encoded — a
    // single strip pass sees no literal "<" to remove.
    const escaped = '&lt;p&gt;Hello &amp;amp; world&lt;/p&gt;&lt;p&gt;Second&lt;/p&gt;';
    expect(htmlToText(escaped)).toBe('Hello & world\nSecond');
  });

  test('decodes numeric and extended named entities', () => {
    expect(htmlToText('caf&#233; &#x2014; resum&#233;')).toBe('café — resumé');
    expect(htmlToText('a &mdash; b &ndash; c &hellip; &lsquo;d&rsquo;')).toBe(
      'a — b – c … ‘d’',
    );
  });

  test('is idempotent on already-clean text (greenhouse calls it twice)', () => {
    const clean = htmlToText('<p>We are looking for a <b>Backend Engineer</b>.</p><p>Remote OK.</p>');
    expect(htmlToText(clean)).toBe(clean);
  });

  test('resolves entity-escaped markup + entities in one call; a second call is idempotent (greenhouse.ts pattern)', () => {
    // greenhouse.ts calls htmlToText(htmlToText(content)) on its entity-encoded
    // `content` field. Escaped tags trigger the conditional second strip+decode
    // pass inside a single call, which here also fully resolves the escaped
    // "&amp;amp;" alongside them — so the redundant second call is a safe no-op.
    const doubleEncoded = '&lt;p&gt;Terms &amp;amp; conditions apply&lt;/p&gt;';
    const once = htmlToText(doubleEncoded);
    expect(once).toBe('Terms & conditions apply');
    expect(htmlToText(once)).toBe(once);
  });

  test('a lone double-encoded entity with no revealed tags needs greenhouse.ts\'s second call', () => {
    // Without any escaped markup to trigger the bonus second decode pass, one
    // level of double-encoding survives a single call — this is exactly why
    // greenhouse.ts wraps its own content in htmlToText(htmlToText(...)).
    const once = htmlToText('Terms &amp;amp; conditions apply');
    expect(once).toBe('Terms &amp; conditions apply');
    expect(htmlToText(once)).toBe('Terms & conditions apply');
  });

  test('caps only the final decoded/stripped text, not a still-encoded pass', () => {
    const escaped = '&lt;p&gt;' + 'x'.repeat(20) + '&lt;/p&gt;';
    // Raw input is longer than 10 chars only because of markup/entities; the
    // decoded+stripped text itself is exactly 20 chars.
    expect(htmlToText(escaped, 10)).toHaveLength(10);
    expect(htmlToText(escaped, 30)).toBe('x'.repeat(20));
  });
});

describe('decodeEntities', () => {
  test('decodes named entities', () => {
    expect(decodeEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeEntities('&lt;tag&gt; &quot;q&quot; &apos;a&apos;')).toBe('<tag> "q" \'a\'');
  });

  test('decodes decimal and hex numeric entities via String.fromCodePoint', () => {
    expect(decodeEntities('&#38;')).toBe('&');
    expect(decodeEntities('&#x26;')).toBe('&');
    expect(decodeEntities('&#8212;')).toBe('—');
  });

  test('leaves unknown entities untouched', () => {
    expect(decodeEntities('&notarealentity;')).toBe('&notarealentity;');
  });
});

describe('sleep', () => {
  test('resolves after roughly the given delay', async () => {
    const start = Date.now();
    await sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});

describe('toMillis', () => {
  test('treats small numbers as unix seconds', () => {
    expect(toMillis(1780540143)).toBe(1780540143000);
  });

  test('passes through millisecond numbers', () => {
    expect(toMillis(1780540143000)).toBe(1780540143000);
  });

  test('parses ISO strings', () => {
    expect(toMillis('2026-06-02T20:15:53Z')).toBe(Date.parse('2026-06-02T20:15:53Z'));
  });

  test('returns null for missing / unparseable values', () => {
    expect(toMillis(undefined)).toBeNull();
    expect(toMillis('not a date')).toBeNull();
    expect(toMillis(NaN)).toBeNull();
  });
});

describe('matchesAny', () => {
  test('matches a keyword in any part, case-insensitively', () => {
    expect(matchesAny(['node'], 'Senior NODE Developer')).toBe(true);
    expect(matchesAny(['node'], 'Backend Engineer', ['golang', 'NodeJS'])).toBe(true);
  });

  test('returns false when nothing matches', () => {
    expect(matchesAny(['python'], 'Node Developer', ['react'])).toBe(false);
  });

  test('empty keyword list matches nothing', () => {
    expect(matchesAny([], 'anything')).toBe(false);
  });
});

describe('postingMatchesKeywords', () => {
  test('admits on a title match or a whole-word body match', () => {
    expect(postingMatchesKeywords(['backend'], 'Backend Engineer', undefined)).toBe(true);
    expect(postingMatchesKeywords(['backend'], 'Software Engineer II', 'Own our backend services.')).toBe(true);
  });

  test('body match is whole-word, not substring, and absent/empty keywords admit nothing', () => {
    expect(postingMatchesKeywords(['java'], 'Software Engineer II', 'Strong JavaScript skills.')).toBe(false);
    expect(postingMatchesKeywords(['backend'], 'Software Engineer II', undefined)).toBe(false);
    expect(postingMatchesKeywords([], 'Backend Engineer', 'backend')).toBe(false);
  });
});

describe('titleMatchesKeywords', () => {
  test('matches whole words/phrases only, not substrings', () => {
    expect(titleMatchesKeywords(['java'], 'Senior Java Developer')).toBe(true);
    expect(titleMatchesKeywords(['java'], 'JavaScript Engineer')).toBe(false);
    expect(titleMatchesKeywords(['backend engineer'], 'Senior Backend Engineer, IAM')).toBe(true);
  });

  test('empty keyword list matches nothing', () => {
    expect(titleMatchesKeywords([], 'Anything')).toBe(false);
  });
});
