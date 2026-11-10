export const insertEventsQuery =
  "SELECT event, value FROM system.events WHERE event IN ('InsertQuery', 'AsyncInsertQuery') FORMAT JSON";

export function parseInsertEvents(body) {
  return Object.fromEntries(JSON.parse(body).data.map((row) => [row.event, Number(row.value)]));
}

export function assessInsertMode({ asyncInsert, events }) {
  const asyncQueries = events.AsyncInsertQuery ?? 0;
  if (asyncInsert && !(asyncQueries > 0)) return ['Async insert mode was not observed'];
  if (!asyncInsert && asyncQueries !== 0)
    return ['Unexpected async inserts in a synchronous profile'];
  return [];
}
