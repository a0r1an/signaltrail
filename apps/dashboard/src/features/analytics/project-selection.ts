import {
  createProjectListReader,
  type AccessOptions,
  type ProjectPage,
} from '@signaltrail/project-access';
import type { OwnerAccess } from '../auth/owner-access';
export type ProjectSelectionResult =
  | { status: 'available'; page: ProjectPage }
  | { status: 'unauthenticated' | 'forbidden' | 'unavailable' | 'invalid_query' };
export function createOwnerProjectReader(options: {
  readOwnerAccess(): Promise<OwnerAccess>;
  query: AccessOptions['query'];
}) {
  const { readOwnerAccess, query } = options;
  const read = createProjectListReader(query);
  return async (
    input: { cursor?: string; limit?: number },
    signal: AbortSignal,
  ): Promise<ProjectSelectionResult> => {
    let access: OwnerAccess;
    try {
      signal.throwIfAborted();
      access = await readOwnerAccess();
      signal.throwIfAborted();
    } catch {
      return { status: 'unavailable' };
    }
    if (access.status !== 'authorized') return { status: access.status };
    try {
      return { status: 'available', page: await read(access.principal, input, signal) };
    } catch (error) {
      return {
        status:
          error instanceof TypeError || error instanceof RangeError
            ? 'invalid_query'
            : 'unavailable',
      };
    }
  };
}
export function selectedProject(page: ProjectPage, requested: unknown) {
  if (requested === undefined) return page.projects[0];
  if (typeof requested !== 'string') return undefined;
  return page.projects.find((project) => project.id === requested.toLowerCase());
}
