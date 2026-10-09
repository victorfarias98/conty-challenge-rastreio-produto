import { AggregatorError, type TrackingAggregator, type TrackingEvent, type TrackingStatus } from "./aggregator.ts";

// Formato do agregador fictício "RastreiaJá". Só este arquivo conhece estes nomes de campo.
export type RawCheckpoint = {
  checkpoint_id?: string;
  tag?: string;
  message?: string;
  checkpoint_time?: string;
};
export type RawTracking = { tracking_number?: string; carrier?: string; checkpoints?: RawCheckpoint[] };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

// Tudo o que não estiver aqui vira "unknown". Lista fechada de propósito: status novo não é adivinhado.
const STATUS_BY_TAG: Record<string, TrackingStatus> = {
  inforeceived: "posted",
  posted: "posted",
  intransit: "in_transit",
  outfordelivery: "out_for_delivery",
  delivered: "delivered",
  exception: "exception",
  failedattempt: "exception",
  returned: "exception",
};

export function normalizeCheckpoint(raw: RawCheckpoint): TrackingEvent | null {
  const occurredAt = new Date(raw.checkpoint_time ?? "");
  // Sem horário válido não dá para ordenar o evento; ele é descartado em vez de ganhar um horário inventado.
  if (Number.isNaN(occurredAt.getTime())) return null;
  const rawStatus = (raw.tag ?? "").trim();
  const occurredAtIso = occurredAt.toISOString();
  return {
    id: raw.checkpoint_id?.trim() || `${rawStatus}@${occurredAtIso}`,
    status: STATUS_BY_TAG[rawStatus.toLowerCase()] ?? "unknown",
    raw_status: rawStatus,
    description: (raw.message ?? "").trim(),
    occurred_at: occurredAtIso,
  };
}

export class HttpAggregator implements TrackingAggregator {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;

  constructor(options: { baseUrl: string; apiKey: string; fetch?: FetchLike }) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch ?? fetch;
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: { "content-type": "application/json", "x-api-key": this.#apiKey },
      });
    } catch (error) {
      throw new AggregatorError(`agregador inacessível: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async register(trackingCode: string): Promise<void> {
    const res = await this.#request("/trackings", {
      method: "POST",
      body: JSON.stringify({ tracking_number: trackingCode }),
    });
    // 409 é "código já cadastrado": para nós, cadastrar de novo é o mesmo que já estar cadastrado.
    if (!res.ok && res.status !== 409) throw new AggregatorError(`agregador respondeu ${res.status} ao cadastrar`);
  }

  async fetchEvents(trackingCode: string): Promise<TrackingEvent[]> {
    const res = await this.#request(`/trackings/${encodeURIComponent(trackingCode)}`);
    if (!res.ok) throw new AggregatorError(`agregador respondeu ${res.status} ao consultar`);
    const body = (await res.json().catch(() => null)) as RawTracking | null;
    const checkpoints = Array.isArray(body?.checkpoints) ? body.checkpoints : [];
    return checkpoints.map(normalizeCheckpoint).filter((event): event is TrackingEvent => event !== null);
  }
}
