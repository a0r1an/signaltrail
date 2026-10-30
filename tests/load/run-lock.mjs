import { open, unlink } from 'node:fs/promises';

// Fixed ports, target discovery, and the Compose project require one run at a time.
export async function acquireRunLock(path) {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (cause) {
    if (cause.code === 'EEXIST')
      throw new Error(
        `A load test is already running, or left a stale lock at ${path}. Check its owner and isolated infrastructure before removing it.`,
        { cause },
      );
    throw cause;
  }
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    await file.close();
    await unlink(path);
    throw error;
  }
  await file.close();
  let releasing;
  return () => (releasing ??= unlink(path));
}
