import type { LogEntry } from './logger';

/** One Analytics Engine data point per finished request. No-op when the binding is absent. */
export function recordMetric(dataset: AnalyticsEngineDataset | undefined, entry: LogEntry): void {
  if (!dataset) return;
  const route = String(entry.matchedPrefix ?? entry.routePrefix ?? '');
  try {
    dataset.writeDataPoint({
      // blob1 route, blob2 method, blob3 auditType (empty for a normal proxied response), blob4 backend, blob5 key id
      blobs: [route, entry.method, String(entry.auditType ?? ''), String(entry.targetUrl ?? ''), String(entry.keyId ?? '')],
      doubles: [entry.status, entry.responseTime], // double1 status, double2 latency ms
      indexes: [route.slice(0, 96)]
    });
  } catch (e) {
    console.error('metrics write failed:', e instanceof Error ? e.message : String(e)); // never fail a request over metrics
  }
}
