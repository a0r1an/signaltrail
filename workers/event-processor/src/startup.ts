export class ProcessorStartupTimeoutError extends Error {
  override name = 'ProcessorStartupTimeoutError';
}
export async function startWithDeadline(start: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(start),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ProcessorStartupTimeoutError('Processor startup deadline exceeded')),
          90000,
        );
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
