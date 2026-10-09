import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AggregatorError, type TrackingAggregator } from "./aggregator.ts";
import { type Clock, type Notifier, TrackingError, createTracking } from "./tracking.ts";

export const DEFAULT_MAX_TRANSIT_HOURS = 240;

export function createApp(
  db: DatabaseSync,
  options: { aggregator: TrackingAggregator; clock?: Clock; maxTransitHours?: number; notify?: Notifier },
) {
  const tracking = createTracking(db, {
    aggregator: options.aggregator,
    clock: options.clock ?? (() => new Date()),
    maxTransitHours: options.maxTransitHours ?? DEFAULT_MAX_TRANSIT_HOURS,
    notify: options.notify ?? ((alert) => console.warn(JSON.stringify({ msg: "shipment.delayed", ...alert }))),
  });
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof TrackingError) {
      return c.json({ error: { code: error.code, message: error.message } }, error.status);
    }
    if (error instanceof AggregatorError) {
      return c.json({ error: { code: "aggregator_unavailable", message: error.message } }, 502);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "erro interno" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/shipments", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const input = body && typeof body === "object" ? (body as { tracking_code?: unknown }) : {};
    const result = await tracking.register(input);
    return c.json(result.shipment, result.created ? 201 : 200);
  });

  app.get("/shipments/:code", (c) => c.json(tracking.view(c.req.param("code").toUpperCase())));

  app.post("/shipments/:code/sync", async (c) => c.json(await tracking.sync(c.req.param("code").toUpperCase())));

  app.post("/delays/check", async (c) => c.json(await tracking.checkDelays()));

  return app;
}
