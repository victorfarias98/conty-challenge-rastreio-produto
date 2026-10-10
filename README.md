# Conty. Rastreio do produto enviado ao criador

Cadastra o código de rastreio num agregador, guarda os eventos, traduz o status de cada transportadora para um conjunto pequeno e avisa quando o trânsito passa do limite.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev
```

A API sobe em `http://127.0.0.1:3007` e grava em `data/rastreio.sqlite`.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3007` | porta |
| `DB_PATH` | `data/rastreio.sqlite` | banco |
| `MAX_TRANSIT_HOURS` | `240` | limite de trânsito antes do aviso |
| `AGGREGATOR_URL` | não definida | URL do agregador |
| `AGGREGATOR_API_KEY` | `chave-ficticia` | chave enviada em `x-api-key` |

Sem `AGGREGATOR_URL`, o `npm run dev` usa um agregador de mentira que responde sempre o mesmo payload de exemplo, só para exercitar a API à mão. Ele entra pelo mesmo cliente HTTP do agregador real.

## Por onde ler

1. `src/aggregator.ts`: a interface `TrackingAggregator` e o evento normalizado. É a fronteira.
2. `src/http-aggregator.ts`: o cliente HTTP e a tradução do payload bruto. Só ele conhece o formato do agregador.
3. `src/tracking.ts`: status atual, histórico sem duplicar e a regra de atraso.
4. `test/tracking.test.ts` e `test/http-aggregator.test.ts`.

## Payload bruto e status normalizado

O que o agregador fictício devolve em `GET /trackings/BR123456789`:

```json
{
  "tracking_number": "BR123456789",
  "carrier": "correios",
  "checkpoints": [
    { "checkpoint_id": "ck_1", "tag": "InfoReceived", "message": "Objeto postado", "checkpoint_time": "2026-03-10T09:00:00-03:00" },
    { "checkpoint_id": "ck_2", "tag": "InTransit", "message": "Em trânsito para Curitiba", "checkpoint_time": "2026-03-11T08:30:00Z" },
    { "checkpoint_id": "ck_3", "tag": "Teleportado", "message": "Objeto teleportado", "checkpoint_time": "2026-03-11T09:00:00Z" }
  ]
}
```

O que sai de `normalizeCheckpoint` para o resto do sistema:

```json
[
  { "id": "ck_1", "status": "posted", "raw_status": "InfoReceived", "description": "Objeto postado", "occurred_at": "2026-03-10T12:00:00.000Z" },
  { "id": "ck_2", "status": "in_transit", "raw_status": "InTransit", "description": "Em trânsito para Curitiba", "occurred_at": "2026-03-11T08:30:00.000Z" },
  { "id": "ck_3", "status": "unknown", "raw_status": "Teleportado", "description": "Objeto teleportado", "occurred_at": "2026-03-11T09:00:00.000Z" }
]
```

| Status | Tags do agregador |
|---|---|
| `posted` | `InfoReceived`, `Posted` |
| `in_transit` | `InTransit` |
| `out_for_delivery` | `OutForDelivery` |
| `delivered` | `Delivered` |
| `exception` | `Exception`, `FailedAttempt`, `Returned` |
| `unknown` | qualquer outra |

A lista é fechada. Um status que a transportadora inventou vira `unknown`: fica no histórico com o texto original em `raw_status`, não muda o status do envio e nunca vira `delivered`.

## Como o status atual é decidido

- Vale o evento que **aconteceu** por último (`occurred_at`), não o que chegou por último. Um evento antigo entregue depois entra no histórico e não faz o status voltar.
- `delivered` é final. Depois da entrega, nenhum evento rebaixa o envio.
- Empate de horário: vence o status mais avançado.
- O histórico tem chave (código, id do evento). Consultar o mesmo código de novo não duplica nada; `new_events` na resposta do sync diz quantos eram novos.

## Como o atraso é detectado

O trânsito começa no primeiro evento conhecido e termina na entrega. Com o limite `MAX_TRANSIT_HOURS`:

| Situação | `delay.state` | Avisa? |
|---|---|---|
| Sem nenhum evento ainda | `not_started` | não |
| Não entregue, trânsito até o limite | `on_time` | não |
| Não entregue, trânsito acima do limite | `delayed` | sim, uma vez |
| Entregue dentro do limite | `delivered` | não |
| Entregue acima do limite | `delivered_late` | não |

Três cuidados para a entrega normal não virar atraso:

- A conta usa o horário do evento de entrega, não o horário da consulta. Um envio entregue em 48 h continua `delivered` se for consultado um mês depois.
- `POST /delays/check` consulta o agregador antes de julgar cada envio não entregue. Um pacote que já chegou, mas cujo evento ainda não tinha sido buscado, não gera aviso.
- Se a consulta ao agregador falha, o envio fica sem veredito naquela rodada e aparece em `sync_failures`.

O aviso é gravado uma vez por envio e entregue a um `notify` injetado em `createApp`. O padrão só escreve no log.

## API

| Rota | Faz |
|---|---|
| `POST /shipments` | cadastra o código (`{ "tracking_code": "BR123456789" }`) aqui e no agregador |
| `GET /shipments/:code` | status, atraso e histórico |
| `POST /shipments/:code/sync` | busca eventos no agregador e grava os novos |
| `POST /delays/check` | sincroniza os não entregues e devolve os avisos novos |

`POST /shipments` responde `201` ao criar e `200` se o código já existia. Falha do agregador responde `502 aggregator_unavailable`.

Resposta de `POST /shipments/BR123456789/sync` com o payload acima, consultado em 2026-03-12:

```json
{
  "new_events": 3,
  "shipment": {
    "tracking_code": "BR123456789",
    "status": "in_transit",
    "status_since": "2026-03-11T08:30:00.000Z",
    "delay": { "state": "on_time", "transit_hours": 48, "limit_hours": 240, "alerted_at": null },
    "registered_at": "2026-03-10T12:00:00.000Z",
    "last_synced_at": "2026-03-12T12:00:00.000Z",
    "events": [
      { "id": "ck_1", "status": "posted", "raw_status": "InfoReceived", "description": "Objeto postado", "occurred_at": "2026-03-10T12:00:00.000Z", "first_seen_at": "2026-03-12T12:00:00.000Z" },
      { "id": "ck_2", "status": "in_transit", "raw_status": "InTransit", "description": "Em trânsito para Curitiba", "occurred_at": "2026-03-11T08:30:00.000Z", "first_seen_at": "2026-03-12T12:00:00.000Z" },
      { "id": "ck_3", "status": "unknown", "raw_status": "Teleportado", "description": "Objeto teleportado", "occurred_at": "2026-03-11T09:00:00.000Z", "first_seen_at": "2026-03-12T12:00:00.000Z" }
    ]
  }
}
```

## O que ficou de fora

- **Agendamento.** Ninguém chama `POST /delays/check` sozinho; falta um cron.
- **Webhook do agregador.** Só há consulta; um agregador real também empurra eventos.
- **Retry e limite de taxa** nas chamadas ao agregador. Uma falha vira `502` e a próxima consulta tenta de novo.
- **Limite único de trânsito.** Vale para qualquer transportadora e rota; deveria variar por campanha ou região.
- **`exception` não é final.** Extravio definitivo e tentativa de entrega frustrada caem no mesmo status.
- **Checkpoint sem horário válido é descartado**, sem registro de que existiu.
- Vínculo do envio com criador e campanha, autenticação e paginação.

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus), a partir do enunciado. O formato do agregador fictício e as decisões acima foram propostos pela IA.

O que eu revisei: os padrões de backend, as tipagens, os early returns, as constantes e se os testes realmente testam os cenários de falha.
