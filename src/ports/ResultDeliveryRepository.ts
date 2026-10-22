import type { RequestResult } from "./RequestResultRepository";

export type DeliveryChunk =
  | Readonly<{ html: string; plain: string }>
  | Readonly<{ kind: "photo" | "document"; image: number }>;
export type DeliveryMetadata = Readonly<{
  requestId: string;
  state: "pending" | "delivered" | "failed" | "expired";
  attempts: number;
  nextChunk: number;
  expiresAt: string;
  nextAttemptAt?: string;
  failureCode?: "TELEGRAM_DELIVERY_FAILED" | "TELEGRAM_DELIVERY_EXPIRED";
}>;
export type DeliveryAttempt = DeliveryMetadata &
  Readonly<{
    result: RequestResult;
    plan?: readonly DeliveryChunk[];
  }>;
export const deliveryRetentionMs = 24 * 60 * 60 * 1000;
export const maxDeliveryAttempts = 6;

// The transport can advance output delivery but cannot settle or enqueue provider work.
export interface ResultDeliveryRepository {
  due(at: string): readonly string[];
  start(id: string, at: string): DeliveryAttempt | null;
  savePlan(id: string, attempt: number, chunks: readonly DeliveryChunk[]): void;
  acknowledge(id: string, attempt: number, nextChunk: number): void;
  complete(id: string, attempt: number, at: string): void;
  fail(id: string, attempt: number, at: string, nextAttemptAt?: string): void;
  expire(at: string): void;
  diagnostics(): readonly DeliveryMetadata[];
}
