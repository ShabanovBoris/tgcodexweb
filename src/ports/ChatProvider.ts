import { z } from "zod";

// Capabilities are immutable for one service lifetime; restart the service to change them.
export const providerCapabilitiesSchema = z
  .strictObject({
    maxConcurrentConversations: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cancellation: z.boolean(),
    fileUpload: z.boolean(),
  })
  .readonly();
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerHealthSchema = z
  .strictObject({
    state: z.enum(["ready", "auth_required", "unavailable"]),
    observedAt: z.iso.datetime(),
  })
  .readonly();
export type ProviderHealth = z.infer<typeof providerHealthSchema>;

const identity = {
  conversationId: z.string().min(1),
  clientRequestId: z.string().min(1),
};
const correlation = { ...identity, providerRequestId: z.string().min(1).optional() };
export type ProviderRequestReference = Readonly<{
  conversationId: string;
  clientRequestId: string;
  providerRequestId?: string;
}>;

export const preSubmitCodes = [
  "SEND_FAILED_PRE_SUBMIT",
  "AUTH_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "CHAT_NOT_FOUND",
  "CHAT_ACCESS_DENIED",
  "ATTACHMENT_REJECTED",
  "UPLOAD_FAILED",
] as const;

const notSubmitted = z.strictObject({
  ...identity,
  state: z.literal("not_submitted"),
  code: z.enum(preSubmitCodes),
});
const submitted = z.strictObject({ ...correlation, state: z.literal("submitted") });
const unknown = z.strictObject({
  ...identity,
  state: z.literal("unknown"),
  code: z.enum(["SUBMISSION_STATE_UNKNOWN", "GENERATION_TIMEOUT"]),
});
export type ProviderSubmission = z.infer<typeof submitted>;

const assistantMessage = z.strictObject({ text: z.string(), id: z.string().min(1).optional() });
export type ProviderAssistantMessage = z.infer<typeof assistantMessage>;
const completed = z.strictObject({
  ...correlation,
  state: z.literal("completed"),
  message: assistantMessage,
});
const cancelled = z.strictObject({ ...correlation, state: z.literal("cancelled") });
const failed = z.strictObject({
  ...correlation,
  state: z.literal("failed"),
  code: z.literal("GENERATION_FAILED"),
});
const timeout = z.strictObject({ ...correlation, state: z.literal("timeout") });
const running = z.strictObject({
  ...correlation,
  state: z.literal("running"),
  partialText: z.string().optional(),
});
const notCancelled = z.strictObject({ ...identity, state: z.literal("not_cancelled") });

export const providerSendResultSchema = z.discriminatedUnion("state", [
  submitted,
  notSubmitted,
  unknown,
]);
export type ProviderSendResult = z.infer<typeof providerSendResultSchema>;
export const providerOutcomeSchema = z.discriminatedUnion("state", [
  completed,
  cancelled,
  failed,
  timeout,
  unknown,
]);
export type ProviderOutcome = z.infer<typeof providerOutcomeSchema>;
export const providerObservationSchema = z.discriminatedUnion("state", [
  running,
  notSubmitted,
  completed,
  cancelled,
  failed,
  timeout,
  unknown,
]);
export type ProviderObservation = z.infer<typeof providerObservationSchema>;
export const providerCancelResultSchema = z.discriminatedUnion("state", [
  completed,
  cancelled,
  failed,
  timeout,
  unknown,
  notCancelled,
]);
export type ProviderCancelResult = z.infer<typeof providerCancelResultSchema>;

export type ProviderAttachmentInput = Readonly<{
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}>;
export type ProviderSendInput = Readonly<{
  conversationId: string;
  clientRequestId: string;
  text?: string;
  attachments: readonly ProviderAttachmentInput[];
}>;
export type ProviderConversation = Readonly<{ id: string; url?: string }>;

export class ProviderOperationError extends Error {
  constructor(readonly code: (typeof preSubmitCodes)[number] | "INVALID_CONVERSATION_REFERENCE") {
    super(code);
    this.name = "ProviderOperationError";
  }
}

/**
 * Evidence belongs to the exact clientRequestId/conversationId (and saved providerRequestId).
 * An adapter may echo clientRequestId only when it can actually correlate the observation;
 * the latest message in a conversation is not sufficient. Uncorrelated reads return unknown.
 * not_submitted proves no prompt crossed the boundary. All thrown send errors are ambiguous.
 * completed/cancelled/failed/timeout prove generation has ended; a local deadline without
 * that evidence is unknown/GENERATION_TIMEOUT. Partial text is only a running observation.
 * The application joins wait/cancel before choosing an outcome: completed from either
 * source wins; otherwise awaitCompletion's terminal outcome has priority, and cancel's
 * terminal evidence is a fallback only when observation is unknown. Different terminal
 * kinds do not erase their shared proof that generation ended.
 *
 * awaitCompletion and inspectRequest are read-only. Aborting the wait must settle it after
 * detaching its local resources; it neither cancels generation nor proves a terminal outcome.
 * cancel's acknowledgement alone is not cancellation evidence (return not_cancelled).
 * Mutations and their cleanup must be over when send/cancel settle. No detached mutations.
 */
export interface ChatProvider {
  readonly capabilities: ProviderCapabilities;
  health(): Promise<ProviderHealth>;
  createConversation(input?: Readonly<{ titleHint?: string }>): Promise<ProviderConversation>;
  inspectConversation(reference: string): Promise<ProviderConversation>;
  send(input: ProviderSendInput): Promise<ProviderSendResult>;
  awaitCompletion(
    input: Readonly<{
      submission: ProviderSubmission;
      signal: AbortSignal;
    }>,
  ): Promise<ProviderOutcome>;
  cancel(reference: ProviderRequestReference): Promise<ProviderCancelResult>;
  inspectRequest(reference: ProviderRequestReference): Promise<ProviderObservation>;
}
