import { beforeEach, describe, expect, it } from "vitest";
import { AggregatorError, type TrackingAggregator, type TrackingEvent, type TrackingStatus } from "../src/aggregator.ts";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import type { DelayAlert, ShipmentView } from "../src/tracking.ts";

type App = ReturnType<typeof createApp>;

const CODE = "BR123456789";
const POSTED_AT = "2026-03-10T12:00:00.000Z";
const LIMIT_HOURS = 72;
const HOUR = 3_600_000;

// Um agregador de teste que não fala HTTP: basta implementar a interface.
class FakeAggregator implements TrackingAggregator {
  events: TrackingEvent[] = [];
  registered: string[] = [];
  failing = false;

  async register(trackingCode: string): Promise<void> {
    this.registered.push(trackingCode);
  }

  async fetchEvents(): Promise<TrackingEvent[]> {
    if (this.failing) throw new AggregatorError("agregador fora do ar");
    return this.events;
  }
}

function event(id: string, status: TrackingStatus | "unknown", occurredAt: string, rawStatus = status): TrackingEvent {
  return { id, status, raw_status: rawStatus, description: "", occurred_at: occurredAt };
}

function hoursAfterPosting(hours: number, extraMs = 0): string {
  return new Date(Date.parse(POSTED_AT) + hours * HOUR + extraMs).toISOString();
}

let app: App;
let aggregator: FakeAggregator;
let now: Date;
let notified: DelayAlert[];

async function sync(): Promise<{ new_events: number; shipment: ShipmentView }> {
  const res = await app.request(`/shipments/${CODE}/sync`, { method: "POST" });
  expect(res.status).toBe(200);
  return (await res.json()) as { new_events: number; shipment: ShipmentView };
}

async function checkDelays(): Promise<{ alerts: DelayAlert[]; sync_failures: string[] }> {
  return (await (await app.request("/delays/check", { method: "POST" })).json()) as {
    alerts: DelayAlert[];
    sync_failures: string[];
  };
}

async function shipment(): Promise<ShipmentView> {
  return (await (await app.request(`/shipments/${CODE}`)).json()) as ShipmentView;
}

beforeEach(async () => {
  now = new Date(POSTED_AT);
  aggregator = new FakeAggregator();
  notified = [];
  app = createApp(openDatabase(), {
    aggregator,
    clock: () => now,
    maxTransitHours: LIMIT_HOURS,
    notify: (alert) => notified.push(alert),
  });
  const res = await app.request("/shipments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tracking_code: CODE }),
  });
  expect(res.status).toBe(201);
});

describe("cadastro", () => {
  it("cadastra o código no agregador uma vez só", async () => {
    const again = await app.request("/shipments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracking_code: CODE.toLowerCase() }),
    });
    expect(again.status).toBe(200);
    expect(aggregator.registered).toEqual([CODE]);
    expect((await shipment()).status).toBe("awaiting_posting");
  });

  it("recusa cadastro sem código e responde 404 para código desconhecido", async () => {
    const res = await app.request("/shipments", { method: "POST", body: "{}" });
    expect(res.status).toBe(422);
    expect((await app.request("/shipments/NAOEXISTE")).status).toBe(404);
  });
});

describe("status normalizado", () => {
  it("status inventado pela transportadora fica no histórico e não vira entregue", async () => {
    aggregator.events = [
      event("e1", "posted", hoursAfterPosting(0)),
      event("e2", "in_transit", hoursAfterPosting(5)),
      event("e3", "unknown", hoursAfterPosting(9), "Teleportado" as never),
    ];

    const { shipment: view } = await sync();

    expect(view.status).toBe("in_transit");
    expect(view.events.at(-1)).toMatchObject({ status: "unknown", raw_status: "Teleportado" });
  });

  it("evento antigo que chega depois não faz o status voltar", async () => {
    aggregator.events = [event("e2", "in_transit", hoursAfterPosting(5))];
    expect((await sync()).shipment.status).toBe("in_transit");

    aggregator.events = [event("e2", "in_transit", hoursAfterPosting(5)), event("e1", "posted", hoursAfterPosting(0))];
    const { new_events, shipment: view } = await sync();

    expect(new_events).toBe(1);
    expect(view.status).toBe("in_transit");
    expect(view.status_since).toBe(hoursAfterPosting(5));
    expect(view.events.map((entry) => entry.id)).toEqual(["e1", "e2"]);
  });

  it("depois de entregue, um evento de trânsito atrasado ou posterior não desfaz a entrega", async () => {
    aggregator.events = [event("e1", "posted", hoursAfterPosting(0)), event("e4", "delivered", hoursAfterPosting(40))];
    await sync();

    aggregator.events = [
      ...aggregator.events,
      event("e3", "out_for_delivery", hoursAfterPosting(38)),
      event("e5", "in_transit", hoursAfterPosting(41)),
    ];
    const { shipment: view } = await sync();

    expect(view.status).toBe("delivered");
    expect(view.status_since).toBe(hoursAfterPosting(40));
  });

  it("uma exceção seguida de nova movimentação volta a andar", async () => {
    aggregator.events = [
      event("e1", "posted", hoursAfterPosting(0)),
      event("e2", "exception", hoursAfterPosting(10)),
      event("e3", "in_transit", hoursAfterPosting(20)),
    ];
    expect((await sync()).shipment.status).toBe("in_transit");
  });

  it("consultar de novo o mesmo código não duplica o histórico", async () => {
    aggregator.events = [event("e1", "posted", hoursAfterPosting(0)), event("e2", "in_transit", hoursAfterPosting(5))];
    expect((await sync()).new_events).toBe(2);

    const second = await sync();

    expect(second.new_events).toBe(0);
    expect(second.shipment.events).toHaveLength(2);
  });

  it("responde 502 quando o agregador falha, sem perder o que já tinha", async () => {
    aggregator.events = [event("e1", "posted", hoursAfterPosting(0))];
    await sync();
    aggregator.failing = true;

    const res = await app.request(`/shipments/${CODE}/sync`, { method: "POST" });

    expect(res.status).toBe(502);
    expect((await shipment()).events).toHaveLength(1);
  });
});

describe("atraso em trânsito", () => {
  beforeEach(() => {
    aggregator.events = [event("e1", "posted", hoursAfterPosting(0)), event("e2", "in_transit", hoursAfterPosting(5))];
  });

  it("não avisa quando o trânsito está exatamente no limite", async () => {
    now = new Date(hoursAfterPosting(LIMIT_HOURS));
    expect((await checkDelays()).alerts).toEqual([]);
    expect((await shipment()).delay).toMatchObject({ state: "on_time", transit_hours: LIMIT_HOURS });
  });

  it("avisa uma vez quando o trânsito passa do limite", async () => {
    now = new Date(hoursAfterPosting(LIMIT_HOURS, 1));

    const first = await checkDelays();
    const second = await checkDelays();

    expect(first.alerts).toMatchObject([{ tracking_code: CODE, limit_hours: LIMIT_HOURS }]);
    expect(second.alerts).toEqual([]);
    expect(notified).toHaveLength(1);
    expect((await shipment()).delay).toMatchObject({ state: "delayed", alerted_at: now.toISOString() });
  });

  it("não marca como atraso a entrega normal, mesmo consultada muito depois", async () => {
    aggregator.events = [...aggregator.events, event("e3", "delivered", hoursAfterPosting(48))];
    await sync();
    now = new Date(hoursAfterPosting(500));

    expect((await checkDelays()).alerts).toEqual([]);
    expect((await shipment()).delay).toMatchObject({ state: "delivered", transit_hours: 48 });
  });

  it("não avisa atraso de envio já entregue cujo evento ainda não tinha sido buscado", async () => {
    await sync();
    aggregator.events = [...aggregator.events, event("e3", "delivered", hoursAfterPosting(48))];
    now = new Date(hoursAfterPosting(100));

    expect((await checkDelays()).alerts).toEqual([]);
    expect((await shipment()).status).toBe("delivered");
  });

  it("mostra a entrega que passou do limite como entregue com atraso, sem aviso novo", async () => {
    aggregator.events = [...aggregator.events, event("e3", "delivered", hoursAfterPosting(90))];
    now = new Date(hoursAfterPosting(95));

    expect((await checkDelays()).alerts).toEqual([]);
    expect((await shipment()).delay.state).toBe("delivered_late");
  });

  it("não acusa atraso quando não conseguiu consultar o agregador", async () => {
    await sync();
    aggregator.failing = true;
    now = new Date(hoursAfterPosting(200));

    const result = await checkDelays();

    expect(result).toEqual({ alerts: [], sync_failures: [CODE] });
    expect(notified).toEqual([]);
  });

  it("não começa a contar antes do primeiro evento", async () => {
    aggregator.events = [];
    now = new Date(hoursAfterPosting(500));
    expect((await checkDelays()).alerts).toEqual([]);
    expect((await shipment()).delay.state).toBe("not_started");
  });
});
