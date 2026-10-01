import type { Attachment } from "../domain/Attachment";
import type { Request, RequestTransition } from "../domain/Request";

// Durable identity и attachments создаются атомарно; менять lifecycle можно только через reducer.
export interface RequestRepository {
  create(request: Request, attachments?: readonly Attachment[]): void;
  get(id: string): Request | null;
  findByUpdate(telegramUpdateId: string): Request | null;
  listUnfinished(): Request[];
  transition(id: string, transition: RequestTransition): Request;
  listAttachments(requestId: string): Attachment[];
}
