import { Hono } from 'hono';
import { type Env, execCtx, flushCache, forRoute, getConfig } from './config';
import { findMatchingRoute, proxyRequest } from './router';
import { log, createLogEntry } from './logger';
import { secureEquals } from './auth';
import { isCallerBlocked } from './policy';
import { corsHeaders } from './cors';
import { runHealthChecks } from './health';
import admin from './admin';

export { ReplayGuard } from './replay';

const app = new Hono<{ Bindings: Env }>();

// Admin endpoint to flush cache
app.post('/admin/cache-flush', async c => {
  const startTime = Date.now();
  const adminKey = c.env.ADMIN_KEY;
  const providedKey = c.req.header('X-Admin-Key');
  // Fail closed: no ADMIN_KEY configured means the endpoint is disabled.
  if (!adminKey || !providedKey || !(await secureEquals(providedKey, adminKey))) {
    const responseTime = Date.now() - startTime;
    log(
      createLogEntry(c.req.raw, 401, responseTime, {
        error: 'Unauthorized cache flush attempt'
      })
    );
    return c.json({ success: false, message: 'Unauthorized' }, 401);
  }

  flushCache();

  const responseTime = Date.now() - startTime;
  log(createLogEntry(c.req.raw, 200, responseTime));

  return c.json({
    success: true,
    message: 'Cache flushed successfully'
  });
});

// Versioned config API: GET/PUT /admin/config, GET /admin/config/history, POST /admin/config/rollback
app.route('/admin', admin);

// Health check endpoint
app.get('/health', c => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Handle OPTIONS requests for CORS preflight
app.options('*', async c => {
  const config = await getConfig(c.env, execCtx(c));
  if (isCallerBlocked(c.req.raw, config)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: corsHeaders(c.req.raw, forRoute(config, findMatchingRoute(new URL(c.req.url).pathname, config.routes)?.route), true)
  });
});

// Catch-all proxy handler
app.all('*', async c => {
  return proxyRequest(c);
});

export default {
  fetch: app.fetch,
  // Cron Trigger: active health checks (does nothing unless a route sets healthCheck)
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(runHealthChecks(env));
  }
};
