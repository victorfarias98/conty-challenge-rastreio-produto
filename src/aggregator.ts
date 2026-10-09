// O conjunto pequeno e estável de status que o resto do sistema conhece, em ordem de avanço.
export const TRACKING_STATUSES = ["posted", "in_transit", "out_for_delivery", "delivered", "exception"] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export type TrackingEvent = {
  // Identidade do evento na origem; é o que impede duplicar o histórico.
  id: string;
  // "unknown" guarda o que a transportadora mandou e não sabemos traduzir. Nunca é promovido a outro status.
  status: TrackingStatus | "unknown";
  raw_status: string;
  description: string;
  occurred_at: string;
};

// Tudo o que o domínio precisa de um agregador de rastreio. Trocar de fornecedor é implementar isto.
export interface TrackingAggregator {
  register(trackingCode: string): Promise<void>;
  fetchEvents(trackingCode: string): Promise<TrackingEvent[]>;
}

export class AggregatorError extends Error {}
