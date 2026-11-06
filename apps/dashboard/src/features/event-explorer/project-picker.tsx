import type { ProjectPage } from '@signaltrail/project-access';
import styles from './project-picker.module.css';
export function ProjectPicker({
  page,
  selectedId,
  cursor,
}: {
  page: ProjectPage;
  selectedId?: string;
  cursor?: string;
}) {
  return (
    <section className={styles.picker} aria-label="Project selection">
      {page.projects.length ? (
        <form action="/dashboard" method="get">
          {cursor && <input type="hidden" name="projectCursor" value={cursor} />}
          <div className={styles.field}>
            <label htmlFor="signaltrail-project">Project</label>
            <select
              id="signaltrail-project"
              name="projectId"
              required
              defaultValue={selectedId ?? ''}
            >
              <option value="" disabled>
                Choose a project
              </option>
              {page.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <button type="submit">Open project</button>
        </form>
      ) : (
        <p>No projects are available for this account.</p>
      )}
      <nav aria-label="Project pages">
        {cursor && (
          <form action="/dashboard" method="get">
            <button type="submit">First projects</button>
          </form>
        )}
        {page.hasMore && page.nextCursor && (
          <form action="/dashboard" method="get">
            <input type="hidden" name="projectCursor" value={page.nextCursor} />
            <button type="submit">More projects</button>
          </form>
        )}
      </nav>
    </section>
  );
}
