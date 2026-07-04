import { getToken } from "./firebase";

const API_BASE = import.meta.env.VITE_API_BASE;

if (!API_BASE) {
  throw new Error(
    "VITE_API_BASE is not set. Add it as an environment variable in Render and redeploy."
  );
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number | null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function jsonOrThrow(res: Response) {
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `Request failed (${res.status})`);
  }
  return res.json();
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch(`${API_BASE}/api/conversations`, {
    headers: await authHeaders(),
  });
  return jsonOrThrow(res);
}

export async function getMessages(conversationId: string): Promise<ChatMessage[]> {
  const res = await fetch(
    `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    { headers: await authHeaders() }
  );
  return jsonOrThrow(res);
}

export async function deleteConversation(conversationId: string): Promise<void> {
  const res = await fetch(
    `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE", headers: await authHeaders() }
  );
  await jsonOrThrow(res);
}

/**
 * Send one message on the persistent contract. Streams deltas via onDelta.
 * Returns the conversationId (echoed back, or newly created by the server).
 */
export async function streamChat(
  message: string,
  conversationId: string | null,
  onDelta: (text: string) => void
): Promise<string | null> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: await authHeaders(),
    body: JSON.stringify(
      conversationId ? { conversationId, message } : { message }
    ),
  });

  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `Request failed (${res.status})`);
  }

  const newId = res.headers.get("X-Conversation-Id");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete lines only; keep the trailing partial in the buffer
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return conversationId ?? newId;

      try {
        const json = JSON.parse(payload);
        const delta: string | undefined = json.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch {
        // Ignore malformed/partial frames
      }
    }
  }

  return conversationId ?? newId;
}
