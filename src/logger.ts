// Structured logging utility

export interface LogEntry {
  timestamp: string;
  method: string;
  requestUrl: string;
  path: string;
  status: number;
  responseTime: number;
  // Extra fields (auditType, reason, clientIp, matchedPrefix, targetUrl, ...)
  [key: string]: unknown;
}

export function log(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}

export function createLogEntry(request: Request, status: number, responseTime: number, options: Record<string, unknown> = {}): LogEntry {
  const url = new URL(request.url);

  // Query string is deliberately NOT logged: it can carry tokens or personal data.
  return {
    timestamp: new Date().toISOString(),
    method: request.method,
    requestUrl: url.origin + url.pathname,
    path: url.pathname,
    status,
    responseTime,
    ...options
  };
}

/**
 * Log a proxied or cached request that ended below 400. `LOG_SUCCESS_SAMPLE` (0 to 1, default 1 = log all)
 * keeps only that share of them; failures always go through `log`. Metrics are recorded either way.
 */
export function logSuccess(entry: LogEntry, env: { LOG_SUCCESS_SAMPLE?: string }, random = Math.random): void {
  const rate = env.LOG_SUCCESS_SAMPLE === undefined || env.LOG_SUCCESS_SAMPLE === '' ? 1 : Number(env.LOG_SUCCESS_SAMPLE);
  if (entry.status < 400 && rate >= 0 && rate < 1 && random() >= rate) return;
  log(entry);
}
