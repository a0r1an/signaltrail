import { expect, it } from 'vitest';
import { createPageContextCapture } from '../../src/capture-url.ts';
it('removes unapproved query data, credentials and fragments while capturing campaign separately', () => {
  const capture = createPageContextCapture();
  expect(
    capture(
      'https://user:password@example.com/products?email=private@example.com&utm_source=google&utm_medium=cpc&utm_campaign=launch&utm_term=red+shoes&utm_content=hero#token',
    ),
  ).toEqual({
    url: 'https://example.com/products',
    campaign: {
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: 'launch',
      utm_term: 'red shoes',
      utm_content: 'hero',
    },
  });
});
it('preserves explicitly allowed query fields without retaining campaign parameters in URL', () => {
  const allowed = ['category', 'utm_source'];
  const capture = createPageContextCapture(allowed);
  allowed.push('secret');
  expect(capture('https://example.com/?category=shoes&utm_source=email&secret=token')).toEqual({
    url: 'https://example.com/?category=shoes',
    campaign: { utm_source: 'email' },
  });
});
it('omits ambiguous duplicate parameters instead of guessing attribution', () => {
  expect(
    createPageContextCapture(['category'])(
      'https://example.com/?utm_source=a&utm_source=b&category=a&category=b',
    ),
  ).toEqual({ url: 'https://example.com/', campaign: {} });
});
it('preserves exact campaign case and spaces, without retaining state between calls', () => {
  const capture = createPageContextCapture();
  expect(capture('https://example.com/?utm_source=%20Email%20').campaign).toEqual({
    utm_source: ' Email ',
  });
  expect(capture('https://example.com/next').campaign).toEqual({});
});
it('omits malformed encodings, empty and control-character values', () => {
  expect(
    createPageContextCapture()(
      'https://example.com/?utm_source=%FF&utm_medium=&utm_campaign=%0Aprivate&utm_content=%ZZ',
    ),
  ).toEqual({ url: 'https://example.com/', campaign: {} });
});
it('bounds each captured parameter in UTF-8 bytes without truncating it', () => {
  const capture = createPageContextCapture();
  const fitting = 'é'.repeat(512);
  expect(
    capture(`https://example.com/?utm_source=${encodeURIComponent(fitting)}`).campaign,
  ).toEqual({ utm_source: fitting });
  expect(
    capture(`https://example.com/?utm_source=${encodeURIComponent(fitting + 'é')}`).campaign,
  ).toEqual({});
});
it.each(['javascript:alert(1)', 'data:text/html,secret', '/relative', 'not a URL'])(
  'rejects unsupported URL %s with a generic error',
  (input) => {
    expect(() => createPageContextCapture()(input)).toThrow('Invalid page URL');
  },
);
it('bounds raw URL parsing before processing and rejects lone surrogates', () => {
  for (const input of [
    'https://example.com/?secret=' + 'a'.repeat(16384),
    'https://example.com/?utm_source=\ud800',
  ])
    expect(() => createPageContextCapture()(input)).toThrow('Invalid page URL');
});
it.each([[''], ['\n'], ['a'.repeat(129)], Array.from({ length: 33 }, (_, i) => `param${i}`)])(
  'rejects invalid query allowlist %j',
  (...names) => {
    expect(() => createPageContextCapture(names)).toThrow();
  },
);
