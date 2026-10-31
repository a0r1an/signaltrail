import { expect, it, vi } from 'vitest';
import { createRetryingHandler } from '../../src/retrying-handler.ts';

it('retries the same unconfirmed message and keeps its broker session alive before succeeding', async () => {
  vi.useFakeTimers();
  const message = { topic: 'analytics', partition: 0, offset: '3', value: Buffer.from('event') };
  const received: unknown[] = [];
  const heartbeat = vi.fn(async () => {});
  const controller = new AbortController();
  const processMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error('storage unavailable'))
    .mockResolvedValue({ status: 'stored' });
  try {
    const handle = createRetryingHandler({
      processMessage,
      signal: controller.signal,
      onProcessed: (kind) => received.push(kind),
    });
    const processing = handle(message, heartbeat);
    await vi.advanceTimersByTimeAsync(1000);
    await processing;
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(processMessage.mock.calls[0]![0]).toBe(message);
    expect(processMessage.mock.calls[1]![0]).toBe(message);
    expect(heartbeat).toHaveBeenCalled();
    expect(received).toEqual(['stored']);
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});

it('backs off exponentially while heartbeating throughout longer waits', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const start = Date.now();
  const attempts: number[] = [];
  const heartbeat = vi.fn(async () => {});
  try {
    const handle = createRetryingHandler({
      signal: controller.signal,
      processMessage: async () => {
        attempts.push(Date.now() - start);
        if (attempts.length < 4) throw new Error('storage unavailable');
        return { status: 'stored' };
      },
    });
    const processing = handle(
      { topic: 'analytics', partition: 0, offset: '3', value: null },
      heartbeat,
    );
    await vi.advanceTimersByTimeAsync(7000);
    await processing;
    expect(attempts).toEqual([0, 1000, 3000, 7000]);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(7);
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});

it('caps retries at thirty seconds and stops backoff promptly during shutdown', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const start = Date.now();
  const attempts: number[] = [];
  try {
    const handle = createRetryingHandler({
      signal: controller.signal,
      processMessage: async () => {
        attempts.push(Date.now() - start);
        throw new Error('storage still unavailable');
      },
    });
    const processing = handle(
      { topic: 'analytics', partition: 0, offset: '3', value: null },
      async () => {},
    );
    await vi.advanceTimersByTimeAsync(100000);
    expect(attempts).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
    controller.abort();
    await processing;
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempts).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    controller.abort();
    vi.useRealTimers();
  }
});

it('does not let diagnostics turn a committed success into another processing attempt', async () => {
  const processMessage = vi.fn().mockResolvedValue({ status: 'stored' });
  const handle = createRetryingHandler({
    signal: new AbortController().signal,
    processMessage,
    onProcessed: () => {
      throw new Error('metrics failed');
    },
  });
  await handle({ topic: 'analytics', partition: 0, offset: '3', value: null }, async () => {});
  expect(processMessage).toHaveBeenCalledTimes(1);
});

it('keeps heartbeating while a bounded storage attempt is still pending', async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const heartbeat = vi.fn(async () => {});
  try {
    const handle = createRetryingHandler({
      signal: new AbortController().signal,
      processMessage: async () => {
        await pending;
        return { status: 'stored' };
      },
    });
    const processing = handle(
      { topic: 'analytics', partition: 0, offset: '3', value: null },
      heartbeat,
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(4);
    complete();
    await processing;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    complete();
    vi.useRealTimers();
  }
});

it('surfaces lost broker ownership without claiming a successful processing outcome', async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const onProcessed = vi.fn();
  const failure = new Error('broker session expired');
  const processMessage = vi.fn(async () => {
    await pending;
    return { status: 'stored' as const };
  });
  try {
    const handle = createRetryingHandler({
      signal: new AbortController().signal,
      processMessage,
      onProcessed,
    });
    const processing = handle(
      { topic: 'analytics', partition: 0, offset: '3', value: null },
      async () => {
        throw failure;
      },
    );
    const rejected = expect(processing).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(1000);
    complete();
    await rejected;
    expect(onProcessed).not.toHaveBeenCalled();
    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    complete();
    vi.useRealTimers();
  }
});

it('reports bounded attempt outcomes and elapsed time without letting diagnostics trigger retries', async () => {
  vi.useFakeTimers();
  let clock = 1000;
  const monotonic = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const observed: unknown[] = [];
  const processMessage = vi.fn(async () => {
    clock += 250;
    if (processMessage.mock.calls.length === 1) throw new Error('storage failed');
    return { status: 'stored' as const };
  });
  try {
    const handle = createRetryingHandler({
      signal: new AbortController().signal,
      processMessage,
      onAttempt: (outcome, seconds) => {
        observed.push([outcome, seconds]);
        throw new Error('diagnostics failed');
      },
    });
    const processing = handle(
      { topic: 'analytics', partition: 0, offset: '3', value: null },
      async () => {},
    );
    await vi.advanceTimersByTimeAsync(1000);
    await processing;
    expect(observed).toEqual([
      ['failed', 0.25],
      ['stored', 0.25],
    ]);
    expect(processMessage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    monotonic.mockRestore();
    vi.useRealTimers();
  }
});
