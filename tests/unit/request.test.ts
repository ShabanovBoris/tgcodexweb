import { describe, expect, test } from "bun:test";
import { canonicalConversationKey } from "../../src/domain/Conversation";
import { attachmentSchema } from "../../src/domain/Attachment";
import {
  type Request,
  type RequestState,
  RequestTransitionError,
  requestSchema,
  requestStates,
  transitionRequest,
} from "../../src/domain/Request";

const at = "2026-10-01T00:00:10.000Z";
// Synthetic snapshots represent durable evidence; tests do not need any provider.
function inState(state: RequestState): Request {
  const started = !["created", "queued"].includes(state);
  const submitted = ["running", "completed", "cancel_requested", "cancelled", "timeout"].includes(
    state,
  );
  const finished = ["completed", "failed", "cancelled", "timeout", "unknown"].includes(state);
  return requestSchema.parse({
    id: "r1",
    conversationId: "c1",
    telegramUpdateId: "42",
    state,
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: started ? "2026-10-01T00:00:01.000Z" : undefined,
    submittedAt: submitted ? "2026-10-01T00:00:02.000Z" : undefined,
    finishedAt: finished ? "2026-10-01T00:00:03.000Z" : undefined,
    failureCode: state === "failed" ? "UPLOAD_FAILED" : undefined,
  });
}

// Independent specification of edges, including cancellation completion race from AC-H01.
const edges = new Set([
  "created:queued",
  "created:failed",
  "queued:uploading",
  "queued:sending",
  "queued:failed",
  "uploading:sending",
  "uploading:failed",
  "uploading:unknown",
  "sending:running",
  "sending:failed",
  "sending:unknown",
  "running:completed",
  "running:failed",
  "running:cancel_requested",
  "running:cancelled",
  "running:timeout",
  "running:unknown",
  "cancel_requested:cancelled",
  "cancel_requested:completed",
  "cancel_requested:unknown",
]);

describe("request domain", () => {
  test("accepts exactly the specified state edges; terminal states cannot replay", () => {
    for (const from of requestStates)
      for (const to of requestStates) {
        const input = inState(from);
        const transition = {
          state: to,
          at,
          failureCode:
            to === "failed"
              ? from === "sending"
                ? "SEND_FAILED_PRE_SUBMIT"
                : "UPLOAD_FAILED"
              : undefined,
        };
        if (edges.has(`${from}:${to}`)) expect(transitionRequest(input, transition).state).toBe(to);
        else expect(() => transitionRequest(input, transition)).toThrow(RequestTransitionError);
        expect(input).toEqual(inState(from));
      }
  });

  test("text path captures start and submission separately and preserves IDs", () => {
    let request = inState("created");
    request = transitionRequest(request, { state: "queued", at });
    request = transitionRequest(request, { state: "sending", at });
    expect(request.startedAt).toBe(at);
    expect(request.submittedAt).toBeUndefined();
    request = transitionRequest(request, {
      state: "running",
      at: "2026-10-01T00:00:11.000Z",
      providerRequestId: "opaque-submission",
    });
    request = transitionRequest(request, { state: "completed", at: "2026-10-01T00:00:12.000Z" });
    expect(request).toMatchObject({
      id: "r1",
      telegramUpdateId: "42",
      conversationId: "c1",
      startedAt: at,
      submittedAt: "2026-10-01T00:00:11.000Z",
      finishedAt: "2026-10-01T00:00:12.000Z",
      providerRequestId: "opaque-submission",
    });
  });

  test("uploading start survives sending and unknown does not fabricate submission", () => {
    let request = transitionRequest(inState("queued"), { state: "uploading", at });
    request = transitionRequest(request, { state: "sending", at: "2026-10-01T00:00:11.000Z" });
    request = transitionRequest(request, { state: "unknown", at: "2026-10-01T00:00:12.000Z" });
    expect(request.startedAt).toBe(at);
    expect(request.submittedAt).toBeUndefined();
    expect(request.finishedAt).toBe("2026-10-01T00:00:12.000Z");
  });

  test.each([undefined, "PROVIDER_UNAVAILABLE", "SUBMISSION_STATE_UNKNOWN"])(
    "sending failure requires proven pre-submit classification: %s",
    (failureCode) => {
      expect(() =>
        transitionRequest(inState("sending"), { state: "failed", at, failureCode }),
      ).toThrow(RequestTransitionError);
    },
  );

  test("rejects contradictory evidence and backwards/invalid operation time", () => {
    expect(() =>
      transitionRequest(inState("queued"), { state: "sending", at, providerRequestId: "opaque" }),
    ).toThrow(RequestTransitionError);
    expect(() =>
      transitionRequest(inState("running"), {
        state: "completed",
        at,
        failureCode: "UPLOAD_FAILED",
      }),
    ).toThrow(RequestTransitionError);
    expect(() =>
      transitionRequest(inState("running"), {
        state: "failed",
        at,
        failureCode: "SEND_FAILED_PRE_SUBMIT",
      }),
    ).toThrow(RequestTransitionError);
    expect(() =>
      transitionRequest(inState("running"), { state: "completed", at: "2025-01-01T00:00:00.000Z" }),
    ).toThrow(RequestTransitionError);
    expect(() => transitionRequest(inState("created"), { state: "queued", at: "invalid" })).toThrow(
      RequestTransitionError,
    );
  });

  test("rejects invalid persisted lifecycle metadata", () => {
    expect(requestSchema.safeParse({ ...inState("created"), submittedAt: at }).success).toBe(false);
    expect(requestSchema.safeParse({ ...inState("running"), submittedAt: undefined }).success).toBe(
      false,
    );
    expect(
      requestSchema.safeParse({ ...inState("completed"), finishedAt: undefined }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({ ...inState("created"), providerRequestId: "opaque" }).success,
    ).toBe(false);
    expect(requestSchema.safeParse({ ...inState("created"), state: "invented" }).success).toBe(
      false,
    );
  });

  test("canonical identity uses opaque ID verbatim, independent of aliases and URL", () => {
    const a = { providerConversationId: "opaque/ID?Case=1" };
    expect(canonicalConversationKey(a)).toBe("opaque/ID?Case=1");
    expect(canonicalConversationKey({ ...a })).toBe(canonicalConversationKey(a));
    expect(canonicalConversationKey({ providerConversationId: "opaque/id?Case=1" })).not.toBe(
      canonicalConversationKey(a),
    );
  });

  test("attachment storage reference is generated key, never an arbitrary path", () => {
    const attachment = {
      id: "a",
      requestId: "r",
      sourceFileId: "opaque-file",
      filename: "../../user-name.txt",
      mimeType: "text/plain",
      sizeBytes: 0,
      createdAt: at,
      temporaryStorageKey: "generated_1",
    };
    expect(attachmentSchema.parse(attachment).filename).toBe("../../user-name.txt");
    expect(
      attachmentSchema.safeParse({ ...attachment, temporaryStorageKey: "../../escape" }).success,
    ).toBe(false);
    expect(attachmentSchema.safeParse({ ...attachment, sizeBytes: -1 }).success).toBe(false);
    expect(
      attachmentSchema.safeParse({ ...attachment, sizeBytes: Number.MAX_SAFE_INTEGER + 1 }).success,
    ).toBe(false);
  });
});
