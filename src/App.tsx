import { useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { signIn, signOut, watchAuth } from "./firebase";
import {
  streamChat,
  listConversations,
  getMessages,
  deleteConversation,
  type ChatMessage,
  type ConversationSummary,
} from "./api";

marked.setOptions({ breaks: true });

function renderMarkdown(content: string): { __html: string } {
  const html = marked.parse(content, { async: false }) as string;
  return { __html: DOMPurify.sanitize(html) };
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    return watchAuth((u) => {
      setUser(u);
      setAuthReady(true);
    });
  }, []);

  if (!authReady) return <div className="centered">Loading…</div>;
  if (!user) return <SignInScreen />;
  return <ChatScreen userEmail={user.email ?? ""} />;
}

function SignInScreen() {
  const [error, setError] = useState("");

  async function handleSignIn() {
    setError("");
    try {
      await signIn();
    } catch (err: any) {
      setError(err?.message ?? "Sign-in failed");
    }
  }

  return (
    <div className="centered">
      <div className="signin-card">
        <h1>Personal AI Chat</h1>
        <button className="primary" onClick={handleSignIn}>
          Sign in with Google
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

function ChatScreen({ userEmail }: { userEmail: string }) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshConversations();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  async function refreshConversations() {
    try {
      setConversations(await listConversations());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load conversations");
    }
  }

  async function openConversation(id: string) {
    setDrawerOpen(false);
    if (id === activeId || busy) return;
    setError("");
    setLoadingHistory(true);
    try {
      const history = await getMessages(id);
      setActiveId(id);
      setMessages(history);
    } catch (err: any) {
      setError(err?.message ?? "Failed to load conversation");
    } finally {
      setLoadingHistory(false);
    }
  }

  function newChat() {
    if (busy) return;
    setActiveId(null);
    setMessages([]);
    setError("");
    setDrawerOpen(false);
  }

  async function removeConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    if (busy) return;
    if (!window.confirm("Delete this conversation permanently?")) return;
    try {
      await deleteConversation(id);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === activeId) {
        setActiveId(null);
        setMessages([]);
      }
    } catch (err: any) {
      setError(err?.message ?? "Delete failed");
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setError("");
    setInput("");
    setBusy(true);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ]);

    try {
      const returnedId = await streamChat(text, activeId, (delta) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          next[next.length - 1] = { ...last, content: last.content + delta };
          return next;
        });
      });

      if (!activeId && returnedId) setActiveId(returnedId);
      refreshConversations(); // update titles/ordering in the background
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
      setMessages((prev) =>
        prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : prev
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-layout">
      <header className="topbar">
        <button className="ghost icon" onClick={() => setDrawerOpen(true)}>
          ☰
        </button>
        <span className="topbar-title">Chat</span>
        <span className="topbar-user">{userEmail}</span>
        <button className="ghost" onClick={() => signOut()}>
          Sign out
        </button>
      </header>

      {drawerOpen && (
        <div className="backdrop" onClick={() => setDrawerOpen(false)} />
      )}

      <aside className={`drawer ${drawerOpen ? "open" : ""}`}>
        <button className="primary full" onClick={newChat}>
          + New chat
        </button>
        <div className="conv-list">
          {conversations.length === 0 && (
            <p className="empty-hint small">No conversations yet.</p>
          )}
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => openConversation(c.id)}
            >
              <span className="conv-title">{c.title}</span>
              <button
                className="ghost icon small"
                onClick={(e) => removeConversation(c.id, e)}
                title="Delete"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <div className="messages" ref={scrollRef}>
        {loadingHistory && <p className="empty-hint">Loading…</p>}
        {!loadingHistory && messages.length === 0 && (
          <p className="empty-hint">Start a conversation.</p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`bubble ${m.role}`}>
            {m.role === "assistant" ? (
              m.content ? (
                <div
                  className="md"
                  dangerouslySetInnerHTML={renderMarkdown(m.content)}
                />
              ) : busy && i === messages.length - 1 ? (
                "…"
              ) : (
                ""
              )
            ) : (
              m.content
            )}
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </div>

      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message…"
          rows={1}
        />
        <button className="primary" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
