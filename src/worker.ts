import { Hono } from 'hono';

export { ShuttleState } from './shuttle-state';

const app = new Hono<{ Bindings: Env }>();
const alertTypes = new Set(['driver-on-break', 'reduced-service', 'traffic', 'other']);

// Browser tokens are intentionally delivered to MapKit, never signing keys.
app.get('/api/mapkit-token', (c) => {
  c.header('Cache-Control', 'no-store');
  const token = c.env.APPLE_MAPKIT_TOKEN?.trim();
  return c.json({ token: token || null });
});

app.post('/api/alerts', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (!body || typeof body !== 'object' || !('alert' in body) || typeof body.alert !== 'string' || !alertTypes.has(body.alert)) {
    return c.json({ error: 'Invalid alert' }, 400);
  }

  console.info('Service alert received', { alert: body.alert });
  return c.body(null, 202);
});

// Transport only: no tracking, broadcasts, subscriptions, or arrival calculations.
app.get('/ws', (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('WebSocket upgrade required', 426);
  }
  const id = c.env.SHUTTLE.idFromName('single-shuttle');
  return c.env.SHUTTLE.get(id).fetch(c.req.raw);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));
export default app;
