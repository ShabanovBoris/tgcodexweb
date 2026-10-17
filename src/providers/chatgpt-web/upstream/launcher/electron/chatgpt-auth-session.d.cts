export function readChatGptAuthSession(options: { origin: string; timeoutMs: number }): Promise<{ sessionAuthenticated: boolean; sessionCheckError: string | null }>;
