// Docker can exit successfully even when a profile-gated container keeps a network alive.
export async function teardownIsolatedRun({ remove, remaining, release }) {
  await remove();
  if ((await remaining()).length)
    throw new Error('Isolated containers remain after teardown; run lock retained');
  await release();
}
