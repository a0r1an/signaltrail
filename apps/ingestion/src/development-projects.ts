// Local development identity mapping only. This is not a project-management store.
export function createDevelopmentProjectResolver(
  definitions: unknown,
): (key: string) => string | undefined {
  if (!Array.isArray(definitions)) throw new TypeError('Development projects must be an array');
  const projects = new Map<string, string>();
  for (const value of definitions as unknown[]) {
    if (
      typeof value !== 'object' ||
      value === null ||
      !('key' in value) ||
      !('projectId' in value) ||
      typeof value.key !== 'string' ||
      !/^\S+$/.test(value.key) ||
      typeof value.projectId !== 'string' ||
      !/\S/.test(value.projectId) ||
      projects.has(value.key)
    )
      throw new TypeError('Invalid or duplicate development project configuration');
    projects.set(value.key, value.projectId);
  }
  return (key) => projects.get(key);
}
