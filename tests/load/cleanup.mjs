// Every cleanup action gets a deadline; one failure must not strand later resources.
export async function cleanupResources(steps) {
  const errors = [];
  for (const step of steps) {
    const controller = new AbortController();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => step.run(controller.signal)),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Timed out after ${step.timeoutMs ?? 10000}ms`);
            controller.abort(error);
            reject(error);
          }, step.timeoutMs ?? 10000);
        }),
      ]);
    } catch (cause) {
      errors.push(new Error(`Cleanup failed: ${step.name}`, { cause }));
    } finally {
      clearTimeout(timer);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, errors.map((error) => error.message).join('; '));
}
