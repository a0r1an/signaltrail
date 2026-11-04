import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

type JsonObject = Record<string, unknown>;
const document = JSON.parse(
  readFileSync(new URL('../../../docs/api/analytics.openapi.json', import.meta.url), 'utf8'),
) as JsonObject;
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: false, logger: false });
const validators = new Map<string, ValidateFunction>();

function dereference(value: JsonObject): JsonObject {
  if (typeof value.$ref !== 'string') return value;
  if (!value.$ref.startsWith('#/')) throw new Error('Only local reference schemas are supported');
  let result: unknown = document;
  for (const part of value.$ref.slice(2).split('/')) {
    if (!result || typeof result !== 'object') throw new Error('Missing query reference schema');
    result = (result as JsonObject)[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!result || typeof result !== 'object') throw new Error('Missing query reference schema');
  return result as JsonObject;
}

/** Test-only schema conformance; semantic byte/UInt64/calendar checks stay in runtime readers. */
export function matchesQueryReference(
  operation: 'count' | 'events',
  status: number,
  body: unknown,
): boolean {
  const key = operation + ':' + status;
  let validate = validators.get(key);
  if (!validate) {
    const paths = document.paths as Record<
      string,
      { get: { responses: Record<string, JsonObject> } }
    >;
    const response = paths['/v1/analytics/' + operation]?.get.responses[String(status)];
    if (!response) return false;
    const content = dereference(response).content as
      Record<string, { schema: JsonObject }> | undefined;
    const schema = content?.['application/json']?.schema;
    if (!schema) return false;
    validate = ajv.compile({ components: document.components, ...schema });
    validators.set(key, validate);
  }
  return validate(body);
}

export async function readQueryReferenceResponse(
  operation: 'count' | 'events',
  response: Response,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Reference query response could not be decoded');
  }
  if (
    response.headers.get('cache-control') !== 'no-store' ||
    !response.headers.get('content-type')?.startsWith('application/json') ||
    !matchesQueryReference(operation, response.status, body)
  )
    throw new Error('Query response did not match the reference contract');
  return body;
}
