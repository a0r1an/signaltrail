import { readFile } from 'node:fs/promises';

/** Date-pinned fixtures apply only the schema; retention would expire their rows. */
export const ANALYTICS_SCHEMA = ['001-analytics-events.sql', '003-analytics-read-layout.sql'];
export const ANALYTICS_RETENTION = [
  '002-analytics-retention.sql',
  '004-identity-link-retention.sql',
];

/** ClickHouse HTTP accepts one statement per request; migration files end statements with `;\n`. */
export function splitStatements(source) {
  return source
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter((statement) =>
      statement.split('\n').some((line) => line.trim() && !line.trim().startsWith('--')),
    );
}

export async function clickhouseStatements(files) {
  const statements = [];
  for (const file of files)
    statements.push(
      ...splitStatements(
        await readFile(new URL(`../../infra/clickhouse/${file}`, import.meta.url), 'utf8'),
      ),
    );
  return statements;
}

export async function applyClickHouseSchema(execute, files = ANALYTICS_SCHEMA) {
  for (const statement of await clickhouseStatements(files)) await execute(statement);
}
