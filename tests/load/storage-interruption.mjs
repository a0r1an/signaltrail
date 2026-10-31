import { setTimeout as delay } from 'node:timers/promises';

export async function runStorageInterruption({
  pause,
  resume,
  signal,
  beforeMs = 15000,
  durationMs = 10000,
  wait = (ms) => delay(ms, undefined, { signal }),
  onState = () => {},
}) {
  let mayBePaused = false;
  let failure;
  try {
    await wait(beforeMs);
    signal?.throwIfAborted();
    // A failed pause request can still have reached Docker. Always attempt to undo it.
    mayBePaused = true;
    await pause();
    onState('paused');
    await wait(durationMs);
  } catch (error) {
    failure = error;
  }
  if (mayBePaused) {
    try {
      await resume();
      onState('resumed');
    } catch (error) {
      if (failure)
        throw new AggregateError([failure, error], 'Storage interruption and resume failed');
      throw error;
    }
  }
  if (failure && !(signal?.aborted && failure.name === 'AbortError')) throw failure;
}
