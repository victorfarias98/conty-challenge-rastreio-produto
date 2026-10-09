import { describe, expect, it } from "vitest";
import { AggregatorError } from "../src/aggregator.ts";
import { HttpAggregator, type RawTracking, normalizeCheckpoint } from "../src/http-aggregator.ts";

const RAW: RawTracking = {
  tracking_number: "BR123456789",
  carrier: "correios",
  checkpoints: [
    { checkpoint_id: "ck_1", tag: "InfoReceived", message: "Objeto postado", checkpoint_time: "2026-03-10T09:00:00-03:00" },
    { checkpoint_id: "ck_2", tag: "InTransit", message: "Em trânsito para Curitiba", checkpoint_time: "2026-03-11T08:30:00Z" },
    { checkpoint_id: "ck_3", tag: "Teleportado", message: "Objeto teleportado", checkpoint_time: "2026-03-11T09:00:00Z" },
  ],
};

function client(respond: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const aggregator = new HttpAggregator({
    baseUrl: "http://agregador.exemplo/",
    apiKey: "chave-ficticia",
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return respond(url, init);
    },
  });
  return { aggregator, calls };
}

describe("tradução do payload bruto", () => {
  it("normaliza status e horário do checkpoint", () => {
    expect(normalizeCheckpoint(RAW.checkpoints![0]!)).toEqual({
      id: "ck_1",
      status: "posted",
      raw_status: "InfoReceived",
      description: "Objeto postado",
      occurred_at: "2026-03-10T12:00:00.000Z",
    });
  });

  it("marca como unknown um status que a transportadora inventou, guardando o original", () => {
    expect(normalizeCheckpoint(RAW.checkpoints![2]!)).toMatchObject({ status: "unknown", raw_status: "Teleportado" });
  });

  it("não trata como entregue um status parecido com entregue", () => {
    const event = normalizeCheckpoint({ tag: "DeliveredToNeighbor?", checkpoint_time: "2026-03-11T09:00:00Z" });
    expect(event?.status).toBe("unknown");
  });

  it("gera um id estável quando o checkpoint vem sem id", () => {
    const raw = { tag: "InTransit", checkpoint_time: "2026-03-11T08:30:00Z" };
    expect(normalizeCheckpoint(raw)?.id).toBe(normalizeCheckpoint({ ...raw })?.id);
  });

  it("descarta checkpoint sem horário válido", () => {
    expect(normalizeCheckpoint({ tag: "InTransit", checkpoint_time: "ontem" })).toBeNull();
  });
});

describe("cliente HTTP do agregador", () => {
  it("cadastra o código e consulta os eventos já normalizados", async () => {
    const { aggregator, calls } = client((_url, init) =>
      init?.method === "POST" ? Response.json({}, { status: 201 }) : Response.json(RAW),
    );

    await aggregator.register("BR123456789");
    const events = await aggregator.fetchEvents("BR123456789");

    expect(calls).toEqual([
      { url: "http://agregador.exemplo/trackings", method: "POST", body: { tracking_number: "BR123456789" } },
      { url: "http://agregador.exemplo/trackings/BR123456789", method: "GET", body: undefined },
    ]);
    expect(events.map((event) => event.status)).toEqual(["posted", "in_transit", "unknown"]);
  });

  it("trata código já cadastrado no agregador como sucesso", async () => {
    const { aggregator } = client(() => Response.json({}, { status: 409 }));
    await expect(aggregator.register("BR123456789")).resolves.toBeUndefined();
  });

  it("transforma erro do agregador e falha de rede em AggregatorError", async () => {
    const failing = client(() => Response.json({}, { status: 503 })).aggregator;
    await expect(failing.fetchEvents("BR1")).rejects.toBeInstanceOf(AggregatorError);

    const offline = new HttpAggregator({
      baseUrl: "http://agregador.exemplo",
      apiKey: "chave-ficticia",
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(offline.fetchEvents("BR1")).rejects.toBeInstanceOf(AggregatorError);
  });
});
