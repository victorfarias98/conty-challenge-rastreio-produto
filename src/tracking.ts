import type { DatabaseSync } from "node:sqlite";
import { TRACKING_STATUSES, type TrackingAggregator, type TrackingEvent, type TrackingStatus } from "./aggregator.ts";

export type Clock = () => Date;
export type DelayState = "not_started" | "on_time" | "delayed" | "delivered" | "delivered_late";
export type DelayAlert = { tracking_code: string; transit_hours: number; limit_hours: number; alerted_at: string };
export type Notifier = (alert: DelayAlert) => void;

export type ShipmentView = {
  tracking_code: string;
  // "awaiting_posting": código cadastrado, ainda sem nenhum evento que saibamos traduzir.
  status: TrackingStatus | "awaiting_posting";
  status_since: string | null;
  delay: { state: DelayState; transit_hours: number | null; limit_hours: number; alerted_at: string | null };
  registered_at: string;
  last_synced_at: string | null;
  events: Array<TrackingEvent & { first_seen_at: string }>;
};

export class TrackingError extends Error {
  readonly status: 404 | 422;
  readonly code: string;

  constructor(status: 404 | 422, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type ShipmentRow = { tracking_code: string; registered_at: string; last_synced_at: string | null };
type StoredEvent = TrackingEvent & { first_seen_at: string };

const MS_PER_HOUR = 3_600_000;

// O status atual vem do evento que ACONTECEU por último, não do que chegou por último:
// um evento antigo entregue depois entra no histórico e não muda o status.
// "delivered" é final: depois da entrega, nada rebaixa o envio.
export function currentStatus(events: TrackingEvent[]): { status: TrackingStatus; since: string } | null {
  const known = events.filter((event): event is TrackingEvent & { status: TrackingStatus } => event.status !== "unknown");
  const delivered = known.filter((event) => event.status === "delivered").sort(byOccurrence)[0];
  if (delivered) return { status: "delivered", since: delivered.occurred_at };
  const latest = known.sort(byOccurrence).at(-1);
  return latest ? { status: latest.status, since: latest.occurred_at } : null;
}

// Empate de horário: vence o status mais avançado na ordem de TRACKING_STATUSES.
function byOccurrence(left: TrackingEvent, right: TrackingEvent): number {
  if (left.occurred_at !== right.occurred_at) return left.occurred_at < right.occurred_at ? -1 : 1;
  return (
    TRACKING_STATUSES.indexOf(left.status as TrackingStatus) - TRACKING_STATUSES.indexOf(right.status as TrackingStatus)
  );
}

// O trânsito começa no primeiro evento conhecido e termina na entrega. Envio entregue dentro do
// limite nunca é atraso, não importa quando a pergunta é feita; quem mede é o horário do evento.
export function delayOf(events: TrackingEvent[], now: Date, limitHours: number): { state: DelayState; transit_hours: number | null } {
  const known = events.filter((event) => event.status !== "unknown").sort(byOccurrence);
  const first = known[0];
  if (!first) return { state: "not_started", transit_hours: null };
  const status = currentStatus(events);
  const end = status?.status === "delivered" ? Date.parse(status.since) : now.getTime();
  const transitHours = Math.max(0, end - Date.parse(first.occurred_at)) / MS_PER_HOUR;
  const late = transitHours > limitHours;
  if (status?.status === "delivered") return { state: late ? "delivered_late" : "delivered", transit_hours: transitHours };
  return { state: late ? "delayed" : "on_time", transit_hours: transitHours };
}

export function createTracking(
  db: DatabaseSync,
  options: { aggregator: TrackingAggregator; clock: Clock; maxTransitHours: number; notify: Notifier },
) {
  const { aggregator, clock, maxTransitHours, notify } = options;

  function shipmentRow(code: string): ShipmentRow {
    const row = db.prepare("SELECT * FROM shipments WHERE tracking_code = ?").get(code) as ShipmentRow | undefined;
    if (!row) throw new TrackingError(404, "shipment_not_found", "código de rastreio não cadastrado");
    return row;
  }

  function eventsOf(code: string): StoredEvent[] {
    return db
      .prepare(
        `SELECT event_id AS id, status, raw_status, description, occurred_at, first_seen_at
         FROM tracking_events WHERE tracking_code = ? ORDER BY occurred_at, rowid`,
      )
      .all(code) as StoredEvent[];
  }

  function view(code: string): ShipmentView {
    const shipment = shipmentRow(code);
    const events = eventsOf(code);
    const status = currentStatus(events);
    const alert = db.prepare("SELECT alerted_at FROM delay_alerts WHERE tracking_code = ?").get(code) as
      | { alerted_at: string }
      | undefined;
    return {
      tracking_code: shipment.tracking_code,
      status: status?.status ?? "awaiting_posting",
      status_since: status?.since ?? null,
      delay: { ...delayOf(events, clock(), maxTransitHours), limit_hours: maxTransitHours, alerted_at: alert?.alerted_at ?? null },
      registered_at: shipment.registered_at,
      last_synced_at: shipment.last_synced_at,
      events,
    };
  }

  async function register(input: { tracking_code?: unknown }): Promise<{ created: boolean; shipment: ShipmentView }> {
    const code = typeof input.tracking_code === "string" ? input.tracking_code.trim().toUpperCase() : "";
    if (!code) throw new TrackingError(422, "tracking_code_required", "tracking_code é obrigatório");
    if (db.prepare("SELECT 1 FROM shipments WHERE tracking_code = ?").get(code)) {
      return { created: false, shipment: view(code) };
    }
    await aggregator.register(code);
    db.prepare("INSERT OR IGNORE INTO shipments (tracking_code, registered_at) VALUES (?, ?)").run(code, clock().toISOString());
    return { created: true, shipment: view(code) };
  }

  async function sync(code: string): Promise<{ new_events: number; shipment: ShipmentView }> {
    shipmentRow(code);
    const events = await aggregator.fetchEvents(code);
    const seenAt = clock().toISOString();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO tracking_events (tracking_code, event_id, status, raw_status, description, occurred_at, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    let newEvents = 0;
    for (const event of events) {
      const result = insert.run(code, event.id, event.status, event.raw_status, event.description, event.occurred_at, seenAt);
      newEvents += Number(result.changes);
    }
    db.prepare("UPDATE shipments SET last_synced_at = ? WHERE tracking_code = ?").run(seenAt, code);
    return { new_events: newEvents, shipment: view(code) };
  }

  // Consulta o agregador antes de julgar: um envio já entregue cujo evento ainda não buscamos
  // não pode virar aviso de atraso. Se a consulta falha, o envio fica sem veredito nesta rodada.
  async function checkDelays(): Promise<{ alerts: DelayAlert[]; sync_failures: string[] }> {
    const codes = (db.prepare("SELECT tracking_code FROM shipments ORDER BY tracking_code").all() as ShipmentRow[]).map(
      (row) => row.tracking_code,
    );
    const alerts: DelayAlert[] = [];
    const syncFailures: string[] = [];
    for (const code of codes) {
      if (currentStatus(eventsOf(code))?.status === "delivered") continue;
      try {
        await sync(code);
      } catch {
        syncFailures.push(code);
        continue;
      }
      const delay = delayOf(eventsOf(code), clock(), maxTransitHours);
      if (delay.state !== "delayed" || delay.transit_hours === null) continue;
      const alert: DelayAlert = {
        tracking_code: code,
        transit_hours: delay.transit_hours,
        limit_hours: maxTransitHours,
        alerted_at: clock().toISOString(),
      };
      const inserted = db
        .prepare("INSERT OR IGNORE INTO delay_alerts (tracking_code, alerted_at, transit_hours) VALUES (?, ?, ?)")
        .run(code, alert.alerted_at, alert.transit_hours);
      if (Number(inserted.changes) === 0) continue;
      alerts.push(alert);
      notify(alert);
    }
    return { alerts, sync_failures: syncFailures };
  }

  return { register, sync, view, checkDelays };
}
