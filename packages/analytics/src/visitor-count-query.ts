import { EVENT_TIME_SQL } from './event-time.ts';
/** Identifiers are validated by the reader; all tenant/filter values use bound parameters. */
export function visitorCountQuery(
  database: string,
  table: string,
  basis: 'received' | 'occurred' = 'received',
): string {
  const time = basis === 'occurred' ? EVENT_TIME_SQL : 'received_at';
  const identity = (field: string) => `JSONExtractString(context_json, 'identity', '${field}')`;
  const identified = `(${identity('kind')} = 'identified' AND ${identity('userId')} = e.distinct_id AND ${identity('anonymousId')} != '')`;
  return `WITH links AS (
    SELECT anonymous_id, min(user_id) AS linked_user, uniqExact(user_id) AS target_count
    FROM (
      SELECT ${identity('anonymousId')} AS anonymous_id, ${identity('userId')} AS user_id, distinct_id
      FROM ${database}.${table} FINAL
      WHERE project_id = unhex({project_hex:String})
        AND ${identity('kind')} IN ('identified', 'link')
    )
    WHERE anonymous_id != '' AND user_id != '' AND user_id = distinct_id
    GROUP BY anonymous_id
  )
  SELECT toString(uniqExact(tuple(
    if(${identified} OR coalesce(l.target_count, 0) = 1, 'user', 'anonymous'),
    if(${identified}, e.distinct_id, if(coalesce(l.target_count, 0) = 1, l.linked_user, e.distinct_id))
  ))) AS count
  FROM ${database}.${table} AS e FINAL
  LEFT JOIN links AS l ON e.distinct_id = l.anonymous_id
  WHERE /* event filters */ event_name != '$identify'
    AND project_id = unhex({project_hex:String})
    AND ${time} >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
    AND ${time} < parseDateTime64BestEffort({to:String}, 3, 'UTC')
  FORMAT JSONEachRow`;
}
