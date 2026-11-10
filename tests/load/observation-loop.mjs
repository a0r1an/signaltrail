import { setTimeout as delay } from 'node:timers/promises';

export async function observeUntil({ done, observe, onError, wait = delay, intervalMs = 2000 }) {
  while (!done()) {
    try {
      await observe();
    } catch (error) {
      await onError(error);
    }
    if (!done()) await wait(intervalMs);
  }
}
