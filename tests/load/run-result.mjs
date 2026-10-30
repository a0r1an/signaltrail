function describeError(error, depth = 0) {
  const description = { name: error?.name ?? 'Error', message: error?.message ?? String(error) };
  if (depth < 4 && error instanceof AggregateError)
    description.errors = error.errors.map((child) => describeError(child, depth + 1));
  if (depth < 4 && error?.cause) description.cause = describeError(error.cause, depth + 1);
  return description;
}

// A successful measurement is not a successful run until teardown has completed.
export async function finishRun({ result, runError, cleanup, writeResult }) {
  const errors = runError ? [runError] : [];
  if (!result.passed && !runError) errors.push(new Error('Load invariants failed'));
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
  const completed = {
    ...result,
    passed: result.passed === true && errors.length === 0,
    errors: errors.map((error) => describeError(error)),
  };
  try {
    await writeResult(completed);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new AggregateError(errors, 'Load run failed; inspect result and diagnostics');
  return completed;
}
