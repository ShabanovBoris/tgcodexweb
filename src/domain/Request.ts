import { z } from "zod";

export const requestStates = [
  "created",
  "queued",
  "uploading",
  "sending",
  "running",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "timeout",
  "unknown",
] as const;
export type RequestState = (typeof requestStates)[number];
export const terminalStates: readonly RequestState[] = [
  "completed",
  "failed",
  "cancelled",
  "timeout",
  "unknown",
];

// Только разрешённые локальные переходы; UNKNOWN не имеет пути к повторной отправке.
export const requestTransitions: Readonly<Record<RequestState, readonly RequestState[]>> = {
  created: ["queued", "failed"],
  queued: ["uploading", "sending", "failed"],
  uploading: ["sending", "failed", "unknown"],
  sending: ["running", "failed", "unknown"],
  running: ["completed", "failed", "cancel_requested", "cancelled", "timeout", "unknown"],
  cancel_requested: ["cancelled", "completed", "failed", "timeout", "unknown"],
  completed: [],
  failed: [],
  cancelled: [],
  timeout: [],
  unknown: [],
};

// startedAt фиксирует локальную работу; submittedAt фиксируется только по evidence от provider.
export const requestSchema = z
  .strictObject({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    telegramUpdateId: z.string().regex(/^(0|[1-9][0-9]*)$/),
    telegramMessageId: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    state: z.enum(requestStates),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    submittedAt: z.iso.datetime().optional(),
    finishedAt: z.iso.datetime().optional(),
    providerRequestId: z.string().min(1).optional(),
    failureCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
  })
  .superRefine((request, context) => {
    const terminal = terminalStates.includes(request.state);
    const needsStart = [
      "uploading",
      "sending",
      "running",
      "cancel_requested",
      "completed",
      "cancelled",
      "timeout",
      "unknown",
    ].includes(request.state);
    const needsSubmission = [
      "running",
      "cancel_requested",
      "completed",
      "cancelled",
      "timeout",
    ].includes(request.state);
    const invalid =
      terminal !== (request.finishedAt !== undefined) ||
      (needsStart && !request.startedAt) ||
      (needsSubmission && !request.submittedAt) ||
      (!!request.submittedAt && !request.startedAt) ||
      (!!request.providerRequestId && !request.submittedAt) ||
      (request.state === "failed" && !request.failureCode) ||
      (request.state !== "failed" && request.failureCode !== undefined) ||
      (!!request.submittedAt && request.failureCode === "SEND_FAILED_PRE_SUBMIT") ||
      (["created", "queued"].includes(request.state) && !!request.startedAt) ||
      (["uploading", "sending"].includes(request.state) && !!request.submittedAt);
    const times = [request.createdAt, request.startedAt, request.submittedAt, request.finishedAt]
      .filter((time): time is string => time !== undefined)
      .map(Date.parse);
    if (invalid || times.some((time, index) => index > 0 && time < times[index - 1])) {
      context.addIssue({ code: "custom", message: "Inconsistent request lifecycle metadata" });
    }
  })
  .readonly();
export type Request = z.infer<typeof requestSchema>;

export type RequestTransition = Readonly<{
  state: RequestState;
  at: string;
  providerRequestId?: string;
  failureCode?: string;
}>;

// Ошибка state machine не содержит prompt/response или upstream исключение.
export class RequestTransitionError extends Error {
  readonly code = "INVALID_REQUEST_TRANSITION";
  constructor() {
    super("INVALID_REQUEST_TRANSITION");
    this.name = "RequestTransitionError";
  }
}

// Pure reducer принимает evidence как business values; он не вызывает provider и не назначает retries.
export function transitionRequest(current: Request, transition: RequestTransition): Request {
  const request = requestSchema.parse(current);
  if (
    !requestTransitions[request.state].includes(transition.state) ||
    (request.state === "sending" &&
      transition.state === "failed" &&
      transition.failureCode !== "SEND_FAILED_PRE_SUBMIT") ||
    (transition.providerRequestId !== undefined && transition.state !== "running") ||
    (transition.failureCode !== undefined && transition.state !== "failed")
  ) {
    throw new RequestTransitionError();
  }
  const result = requestSchema.safeParse({
    ...request,
    state: transition.state,
    startedAt:
      request.startedAt ??
      (["uploading", "sending"].includes(transition.state) ? transition.at : undefined),
    submittedAt: transition.state === "running" ? transition.at : request.submittedAt,
    providerRequestId: transition.providerRequestId ?? request.providerRequestId,
    finishedAt: terminalStates.includes(transition.state) ? transition.at : undefined,
    failureCode: transition.failureCode,
  });
  const previousAt = request.submittedAt ?? request.startedAt ?? request.createdAt;
  if (
    !result.success ||
    !z.iso.datetime().safeParse(transition.at).success ||
    Date.parse(transition.at) < Date.parse(previousAt)
  )
    throw new RequestTransitionError();
  return result.data;
}
