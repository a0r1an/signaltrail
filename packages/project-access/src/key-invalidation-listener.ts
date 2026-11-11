/** Sent by migration 003's trigger with the changed key's SHA-256 hex, or `all` on truncate. */
export const INGESTION_KEY_CHANNEL = 'signaltrail_ingestion_keys';

export interface ListenClient {
  query(text: string): Promise<unknown>;
  on(
    event: 'notification',
    listener: (message: { channel: string; payload?: string }) => void,
  ): unknown;
  on(event: 'error' | 'end', listener: (error?: unknown) => void): unknown;
  end(): Promise<void>;
}
export interface IngestionKeyListenerOptions {
  connect(): Promise<ListenClient>;
  retryMs?: number;
  /** True only while LISTEN is active; caches must not be trusted otherwise. */
  onTrusted(trusted: boolean): void;
  onInvalidate(keyHash: string): void;
  onClear(): void;
}

export function startIngestionKeyListener(options: IngestionKeyListenerOptions) {
  const retryMs = options.retryMs ?? 1000;
  let stopped = false;
  let client: ListenClient | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trusted = false;
  const setTrusted = (value: boolean) => {
    if (trusted === value) return;
    trusted = value;
    options.onTrusted(value);
  };
  const retry = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, retryMs);
  };
  const lost = (current: ListenClient) => {
    if (client !== current) return;
    client = undefined;
    setTrusted(false);
    void current.end().catch(() => {});
    retry();
  };
  async function connect() {
    let current: ListenClient;
    try {
      current = await options.connect();
    } catch {
      retry();
      return;
    }
    if (stopped) {
      void current.end().catch(() => {});
      return;
    }
    client = current;
    current.on('error', () => lost(current));
    current.on('end', () => lost(current));
    current.on('notification', (message) => {
      if (message.channel !== INGESTION_KEY_CHANNEL) return;
      if (/^[a-f0-9]{64}$/.test(message.payload ?? '')) options.onInvalidate(message.payload!);
      else options.onClear();
    });
    try {
      await current.query(`LISTEN ${INGESTION_KEY_CHANNEL}`);
      if (client === current) setTrusted(true);
    } catch {
      lost(current);
    }
  }
  void connect();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      const current = client;
      client = undefined;
      setTrusted(false);
      await current?.end().catch(() => {});
    },
  };
}
