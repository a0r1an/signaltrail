import { expect, it, vi } from 'vitest';
import { ProcessorStartupTimeoutError, startWithDeadline } from '../../src/startup.ts';

it('caps startup at ninety seconds even when the broker keeps the join pending', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  try {
    const starting = startWithDeadline(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const rejected = expect(starting).rejects.toBeInstanceOf(ProcessorStartupTimeoutError);
    await vi.advanceTimersByTimeAsync(90000);
    // Settling a timed-out dependency later cannot turn startup into success.
    finish();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    finish?.();
    vi.useRealTimers();
  }
});

it('removes its deadline after startup succeeds or fails', async () => {
  vi.useFakeTimers();
  try {
    await expect(startWithDeadline(async () => {})).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    const failure = new Error('dependency failed');
    await expect(
      startWithDeadline(() => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
