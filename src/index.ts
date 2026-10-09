import { serve } from "@hono/node-server";
import { DEFAULT_MAX_TRANSIT_HOURS, createApp } from "./app.ts";
import { openDatabase } from "./db.ts";
import { HttpAggregator, type RawTracking } from "./http-aggregator.ts";

// Sem AGGREGATOR_URL, um agregador de mentira responde sempre o mesmo payload de exemplo,
// para a API poder ser exercitada à mão. Ele entra pelo mesmo cliente HTTP do agregador real.
async function sampleAggregator(input: string, init?: RequestInit): Promise<Response> {
  if (init?.method === "POST") return Response.json({ ok: true }, { status: 201 });
  const sample: RawTracking = {
    tracking_number: decodeURIComponent(input.split("/").at(-1) ?? ""),
    carrier: "correios",
    checkpoints: [
      { checkpoint_id: "ck_1", tag: "InfoReceived", message: "Objeto postado", checkpoint_time: "2026-03-10T12:00:00Z" },
      { checkpoint_id: "ck_2", tag: "InTransit", message: "Em trânsito para Curitiba", checkpoint_time: "2026-03-11T08:30:00Z" },
    ],
  };
  return Response.json(sample);
}

const aggregatorUrl = process.env.AGGREGATOR_URL;
const aggregator = new HttpAggregator({
  baseUrl: aggregatorUrl ?? "http://agregador.exemplo",
  apiKey: process.env.AGGREGATOR_API_KEY ?? "chave-ficticia",
  fetch: aggregatorUrl ? undefined : sampleAggregator,
});
const db = openDatabase(process.env.DB_PATH ?? "data/rastreio.sqlite");
const port = Number(process.env.PORT ?? 3007);
const maxTransitHours = Number(process.env.MAX_TRANSIT_HOURS ?? DEFAULT_MAX_TRANSIT_HOURS);

serve({ fetch: createApp(db, { aggregator, maxTransitHours }).fetch, port }, (info) => {
  console.log(`rastreio em http://127.0.0.1:${info.port}`);
});
