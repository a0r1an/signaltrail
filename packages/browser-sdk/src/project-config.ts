export interface EventQueueConfig {
  readonly projectKey: string;
  readonly ingestionUrl: string;
}

export function normalizeQueueConfig(config: EventQueueConfig): EventQueueConfig {
  if (typeof config.projectKey !== 'string' || !/\S/.test(config.projectKey)) {
    throw new TypeError('projectKey must be a nonblank string');
  }
  const invalidEndpoint =
    'ingestionUrl must be an absolute HTTP(S) URL without credentials or a fragment';
  let endpoint: URL;
  try {
    endpoint = new URL(config.ingestionUrl);
  } catch {
    throw new TypeError(invalidEndpoint);
  }
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  ) {
    throw new TypeError(invalidEndpoint);
  }
  return Object.freeze({ projectKey: config.projectKey, ingestionUrl: endpoint.href });
}
