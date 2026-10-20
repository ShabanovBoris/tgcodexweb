import type { Request, RequestTransition } from "../domain/Request";
import type { ProviderAssistantMessage } from "./ChatProvider";

export type RequestResult = Readonly<{
  request: Request;
  message?: ProviderAssistantMessage;
  errorCode?: string;
}>;
// Settlement and operational output commit together; delivery never calls the provider.
export interface RequestResultRepository {
  settle(
    id: string,
    transition: RequestTransition,
    output: Omit<RequestResult, "request">,
  ): RequestResult;
}
