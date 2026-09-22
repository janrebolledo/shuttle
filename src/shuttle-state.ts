import { DurableObject } from 'cloudflare:workers';
import { etaRange, MAX_ACCURACY_METERS, ROUTE_WIDTH_METERS, routePosition, stops, type Direction, type Point } from './shuttle';

const REPORT_TTL_MS = 75_000;
const CLUSTER_WINDOW_MS = 35_000;
const CLUSTER_RADIUS_METERS = 250;
const REPORT_INTERVAL_MS = 5_000;

type RiderReport = Point & {
  sessionId: string;
  direction: Direction;
  speedMps: number;
  accuracy: number;
  progress: number;
  evidence: number;
  updatedAt: number;
};

type Estimate = {
  latitude: number;
  longitude: number;
  direction: Direction;
  updatedAt: number;
  contributors: number;
  arrivals: {
    ssb: { next: { min: number; max: number }; following: { min: number; max: number } };
    current: { next: { min: number; max: number }; following: { min: number; max: number } };
  };
};

export class ShuttleState extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return Response.json({ error: 'WebSocket upgrade required' }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (!client || !server) return new Response('WebSocket unavailable', { status: 500 });
    this.ctx.acceptWebSocket(server, ['shuttle']);
    server.serializeAttachment({ sessionId: null, lastUpdateAt: 0 });
    server.send(JSON.stringify({ type: 'snapshot', estimate: await this.getEstimate() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;
    let body: unknown;
    try { body = JSON.parse(message); } catch { return; }
    if (!body || typeof body !== 'object') return;

    const attachment = socket.deserializeAttachment() as { sessionId: string | null; lastUpdateAt: number } | null;
    if (!attachment) return;
    if ('type' in body && body.type === 'stop' && attachment.sessionId) {
      await this.ctx.storage.delete(`r:${attachment.sessionId}`);
      socket.serializeAttachment({ sessionId: null, lastUpdateAt: 0 });
      await this.scheduleCleanup();
      await this.publish();
      return;
    }

    if (!('type' in body) || body.type !== 'location' || !isLocation(body)) return;
    const now = Date.now();
    if (now - attachment.lastUpdateAt < REPORT_INTERVAL_MS) return;
    if (attachment.sessionId && attachment.sessionId !== body.sessionId) return;
    const { rawProgress, crossTrackMeters, routeLengthMeters } = routePosition(body);
    if (rawProgress < -0.1 || rawProgress > 1.1 || crossTrackMeters > ROUTE_WIDTH_METERS) return;

    const key = `r:${body.sessionId}`;
    const previous = await this.ctx.storage.get<RiderReport>(key);
    const distanceFromStop = Math.min(distance(body, stops.ssb), distance(body, stops.current));
    let evidence = 1;
    let speedMps = 0;
    if (!previous) {
      if (distanceFromStop > 250) return;
    } else {
      const elapsed = now - previous.updatedAt;
      const progressDelta = rawProgress - previous.progress;
      const alignedProgress = body.direction === 'to-current' ? progressDelta : -progressDelta;
      if (elapsed > 30_000 || previous.direction !== body.direction || alignedProgress < -0.015) {
        await this.ctx.storage.delete(key);
        if (distanceFromStop > 250) return;
      } else {
        evidence = previous.evidence + (alignedProgress >= 0.015 ? 1 : 0);
        speedMps = elapsed > 0 ? alignedProgress * routeLengthMeters * 1.3 / (elapsed / 1000) : 0;
        if (speedMps > 15) return;
        if (alignedProgress < 0.015) speedMps = previous.speedMps;
      }
    }

    const report: RiderReport = {
      sessionId: body.sessionId,
      latitude: body.latitude,
      longitude: body.longitude,
      direction: body.direction,
      speedMps,
      accuracy: body.accuracy,
      progress: rawProgress,
      evidence,
      updatedAt: now,
    };
    await this.ctx.storage.put(key, report);
    await this.scheduleCleanup();
    socket.serializeAttachment({ sessionId: report.sessionId, lastUpdateAt: now });
    await this.publish();
  }

  async alarm() {
    const now = Date.now();
    const reports = await this.ctx.storage.list<RiderReport>({ prefix: 'r:' });
    for (const [key, report] of reports) {
      if (now - report.updatedAt > REPORT_TTL_MS) await this.ctx.storage.delete(key);
    }
    await this.scheduleCleanup();
    await this.publish();
  }

  private async scheduleCleanup() {
    const reports = await this.ctx.storage.list<RiderReport>({ prefix: 'r:' });
    if (!reports.size) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    const expiresAt = Math.min(...[...reports.values()].map((report) => report.updatedAt + REPORT_TTL_MS));
    await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, expiresAt));
  }

  private async getEstimate(): Promise<Estimate | null> {
    const now = Date.now();
    const all = [...(await this.ctx.storage.list<RiderReport>({ prefix: 'r:' })).values()]
      .filter((report) => now - report.updatedAt <= REPORT_TTL_MS && report.evidence >= 3);
    if (!all.length) return null;

    const freshest = all.filter((report) => now - report.updatedAt <= CLUSTER_WINDOW_MS);
    if (!freshest.length) return null;
    const groups = freshest.map((anchor) => freshest.filter((report) =>
      report.direction === anchor.direction && distance(report, anchor) <= CLUSTER_RADIUS_METERS,
    ));
    groups.sort((a, b) => b.length - a.length || Math.max(...b.map((item) => item.updatedAt)) - Math.max(...a.map((item) => item.updatedAt)));
    const group = groups[0];
    if (!group?.length || (freshest.length > 1 && group.length === 1)) return null;

    const lead = group[0];
    if (!lead) return null;
    const latitude = median(group.map((item) => item.latitude));
    const longitude = median(group.map((item) => item.longitude));
    const speed = median(group.map((item) => item.speedMps));
    const location = { latitude, longitude };
    return {
      ...location,
      direction: lead.direction,
      updatedAt: Math.max(...group.map((item) => item.updatedAt)),
      contributors: group.length,
      arrivals: {
        ssb: etaRange(location, lead.direction, 'ssb', speed),
        current: etaRange(location, lead.direction, 'current', speed),
      },
    };
  }

  private async publish() {
    const message = JSON.stringify({ type: 'snapshot', estimate: await this.getEstimate() });
    for (const socket of this.ctx.getWebSockets('shuttle')) {
      try { socket.send(message); } catch { /* Closed sockets are removed by the runtime. */ }
    }
  }
}

function isLocation(value: Record<string, unknown>): value is Record<string, unknown> & {
  type: 'location'; sessionId: string; latitude: number; longitude: number;
  accuracy: number; direction: Direction; speedMps: number;
} {
  return value.type === 'location' && typeof value.sessionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.sessionId) &&
    typeof value.latitude === 'number' && Number.isFinite(value.latitude) && value.latitude >= -90 && value.latitude <= 90 &&
    typeof value.longitude === 'number' && Number.isFinite(value.longitude) && value.longitude >= -180 && value.longitude <= 180 &&
    typeof value.accuracy === 'number' && Number.isFinite(value.accuracy) && value.accuracy <= MAX_ACCURACY_METERS && value.accuracy >= 0 &&
    (value.direction === 'to-current' || value.direction === 'to-ssb') &&
    typeof value.speedMps === 'number' && Number.isFinite(value.speedMps) && value.speedMps >= 0 && value.speedMps <= 15;
}

function distance(a: Point, b: Point) {
  return Math.hypot((a.latitude - b.latitude) * 111_320, (a.longitude - b.longitude) * 111_320 * Math.cos(a.latitude * Math.PI / 180));
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
