export interface OutgoingMessage {
  key: string;
  value: string;
  headers: Record<string, string>;
}
interface Pending {
  message: OutgoingMessage;
  resolve(): void;
  reject(error: unknown): void;
}

export function createProducerBatcher(send: (messages: OutgoingMessage[]) => Promise<unknown>) {
  let pending: Pending[] = [];
  let scheduled = false;
  let pendingBytes = 0;
  const flush = () => {
    const batch = pending;
    pending = [];
    pendingBytes = 0;
    if (!batch.length) return;
    void Promise.resolve()
      .then(() => send(batch.map((entry) => entry.message)))
      .then(
        () => {
          for (const entry of batch) entry.resolve();
        },
        (error: unknown) => {
          for (const entry of batch) entry.reject(error);
        },
      );
  };
  return {
    enqueue(message: OutgoingMessage): Promise<void> {
      const bytes =
        Buffer.byteLength(message.value) +
        Buffer.byteLength(message.key) +
        Object.entries(message.headers).reduce(
          (sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value),
          0,
        ) +
        64;
      // A large individual record travels alone; admission still bounds its retained bytes.
      if (pendingBytes && bytes > 256 * 1024 - pendingBytes) flush();
      const result = new Promise<void>((resolve, reject) => {
        pending.push({ message, resolve, reject });
      });
      pendingBytes += bytes;
      if (pending.length >= 100 || pendingBytes >= 256 * 1024) flush();
      if (pending.length && !scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          flush();
        });
      }
      return result;
    },
  };
}
