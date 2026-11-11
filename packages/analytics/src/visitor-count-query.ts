import { EVENT_TIME_SQL } from './event-time.ts';
/** Identifiers are validated by the reader; all tenant/filter values use bound parameters. */
export function visitorCountQuery(
  database: string,
  table: string,
  basis: 'received' | 'occurred' = 'received',
  linksTable = 'analytics_identity_links',
): string {
  const time = basis === 'occurred' ? EVENT_TIME_SQL : 'received_at';
  const window = `project_id = unhex({project_hex:String})
    AND ${time} >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND ${time} < parseDateTime64BestEffort({to:String}, 3, 'UTC')`;
  const identity = (field: string) => `JSONExtractString(context_json, 'identity', '${field}')`;
  const identified = `(${identity('kind')} = 'identified' AND ${identity('userId')} = e.distinct_id AND ${identity('anonymousId')} != '')`;
  // Exactly one retained link target, unambiguous across the project's history.
  const resolved = `(l.linked_user != '' AND l.linked_user = l.other_user)`;
  // Links are limited to IDs active in the window (a superset of the filtered events), so
  // memory follows the window rather than all retained identities.
  return `WITH links AS (
    SELECT anonymous_id, min(user_id) AS linked_user, max(user_id) AS other_user
    FROM ${database}.${linksTable} FINAL
    WHERE project_id = unhex({project_hex:String})
      AND anonymous_id IN (
        SELECT distinct_id FROM ${database}.${table}
        WHERE event_name != '$identify' AND ${window}
      )
    GROUP BY anonymous_id
  )
  SELECT toString(uniqExact(tuple(
    if(${identified} OR ${resolved}, 'user', 'anonymous'),
    if(${identified}, e.distinct_id, if(${resolved}, l.linked_user, e.distinct_id))
  ))) AS count
  FROM ${database}.${table} AS e FINAL
  LEFT JOIN links AS l ON e.distinct_id = l.anonymous_id
  WHERE /* event filters */ event_name != '$identify'
    AND ${window}
  FORMAT JSONEachRow`;
}
