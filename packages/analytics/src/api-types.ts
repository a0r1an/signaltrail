import type { components, operations } from './generated/query-api.ts';

export type {
  paths as AnalyticsApiPaths,
  components as AnalyticsApiComponents,
  operations as AnalyticsApiOperations,
} from './generated/query-api.ts';

export type AnalyticsCountRequest = operations['countReceivedEvents']['parameters']['query'];
export type AnalyticsEventListRequest = operations['listReceivedEvents']['parameters']['query'];
export type AnalyticsCountResponse = components['schemas']['Count'];
export type AnalyticsEventSummary = components['schemas']['EventSummary'];
export type AnalyticsEventPage = components['schemas']['EventPage'];
type ErrorResponse =
  'Error400' | 'Error401' | 'Error403' | 'Error404' | 'Error405' | 'Error414' | 'Error503';
export type AnalyticsQueryError =
  components['responses'][ErrorResponse]['content']['application/json'];
