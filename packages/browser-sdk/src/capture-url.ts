const campaignNames = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;
export type CampaignParameter = (typeof campaignNames)[number];
export interface PageContext {
  url: string;
  campaign: Partial<Record<CampaignParameter, string>>;
}
const encoder = new TextEncoder();
function scalarText(value: string): boolean {
  return Array.from(value).every((character) => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
}
function controlFree(value: string): boolean {
  return Array.from(value).every((character) => {
    const point = character.codePointAt(0)!;
    return point >= 32 && point !== 127;
  });
}
function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return undefined;
  }
}
/** Capture-time privacy policy. This does not validate app-supplied event properties. */
export function createPageContextCapture(allowedQueryParameters: readonly string[] = []) {
  if (
    !Array.isArray(allowedQueryParameters) ||
    allowedQueryParameters.length > 32 ||
    allowedQueryParameters.some(
      (name) =>
        typeof name !== 'string' ||
        name.length > 128 ||
        !/\S/.test(name) ||
        encoder.encode(name).byteLength > 128 ||
        !scalarText(name) ||
        !controlFree(name),
    )
  )
    throw new TypeError('Invalid query parameter allowlist');
  const allowed = new Set(allowedQueryParameters);
  const selected = new Set<string>([...campaignNames, ...allowed]);
  return (input: string): PageContext => {
    let page: URL;
    try {
      if (
        typeof input !== 'string' ||
        input.length > 16384 ||
        !scalarText(input) ||
        encoder.encode(input).byteLength > 16384
      )
        throw new Error();
      page = new URL(input);
      if (!['https:', 'http:'].includes(page.protocol)) throw new Error();
    } catch {
      throw new TypeError('Invalid page URL');
    }
    // Parse only recognized fields. decodeURIComponent rejects invalid UTF-8 rather
    // than silently replacing bytes and changing the campaign's identity.
    const values = new Map<string, string | undefined>();
    for (const pair of page.search.slice(1).split('&')) {
      const separator = pair.indexOf('=');
      const name = decode(separator < 0 ? pair : pair.slice(0, separator));
      if (name === undefined || !selected.has(name)) continue;
      if (values.has(name)) {
        values.set(name, undefined);
        continue;
      }
      const value = decode(separator < 0 ? '' : pair.slice(separator + 1));
      values.set(
        name,
        value && controlFree(value) && encoder.encode(value).byteLength <= 1024 ? value : undefined,
      );
    }
    const campaign: PageContext['campaign'] = {};
    for (const name of campaignNames) {
      const value = values.get(name);
      if (value !== undefined) campaign[name] = value;
    }
    page.username = '';
    page.password = '';
    page.hash = '';
    page.search = '';
    for (const name of allowed) {
      if ((campaignNames as readonly string[]).includes(name)) continue;
      const value = values.get(name);
      if (value !== undefined) page.searchParams.append(name, value);
    }
    return { url: page.href, campaign };
  };
}
