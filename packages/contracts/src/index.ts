export const CONTRACT_VERSION = 1 as const;

export { AnalyticsEventSchema } from './analytics-event.ts';
export {
  AnalyticsBatchResponseSchema,
  isAnalyticsBatchResponseForEvents,
} from './analytics-batch-response.ts';
export { AnalyticsBatchSchema, validateAnalyticsEvents } from './analytics-batch.ts';
export { SdkHealthReportSchema, SDK_HEALTH_COUNTERS } from './sdk-health.ts';
export type { SdkHealthReport, SdkHealthCounter } from './sdk-health.ts';
