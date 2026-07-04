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
  listMemory,
  addMemory,
  updateMemory,
  rememberConversation,
  type ChatMessage,
  type ConversationSummary,
  type MemoryItem,
  type ModelAlias,
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
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [rememberResult, setRememberResult] = useState<string>("");
  const [proMode, setProMode] = useState(false);
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
    setRememberResult("");
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
    setRememberResult("");
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

  async function remember() {
    if (!activeId || remembering) return;
    setRememberResult("");
    setRemembering(true);
    try {
      const result = await rememberConversation(activeId);
      setRememberResult(
        result.added.length === 0 && result.deactivated === 0
          ? "Nothing new to remember."
          : `Remembered ${result.added.length} fact(s)` +
            (result.deactivated > 0 ? `, retired ${result.deactivated} outdated.` : ".")
      );
    } catch (err: any) {
      setRememberResult(err?.message ?? "Extraction failed");
    } finally {
      setRemembering(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setError("");
    setRememberResult("");
    setInput("");
    setBusy(true);

    const model: ModelAlias = proMode ? "pro" : "default";

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
      }, model);

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
        {activeId && (
          <button className="ghost" onClick={remember} disabled={remembering}>
            {remembering ? "…" : "Remember"}
          </button>
        )}
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
        <button
          className="ghost full"
          onClick={() => {
            setDrawerOpen(false);
            setMemoryOpen(true);
          }}
        >
          🧠 Memory
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
                <span className="typing"><span /><span /><span /></span>
              ) : (
                ""
              )
            ) : (
              m.content
            )}
          </div>
        ))}
        {error && <p className="error">{error}</p>}
        {rememberResult && <p className="empty-hint small">{rememberResult}</p>}
      </div>

      <div className="composer">
        <button
          className={`ghost model-toggle ${proMode ? "pro-on" : ""}`}
          onClick={() => setProMode((p) => !p)}
          title={proMode ? "Pro model on (limited daily quota)" : "Using fast model"}
        >
          {proMode ? "PRO" : "fast"}
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={proMode ? "Message (Pro)…" : "Message…"}
          rows={1}
        />
        <button className="primary" onClick={send} disabled={busy || !input.trim()}>
          Send
        </button>
      </div>

      {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}
    </div>
  );
}

function MemoryPanel({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [newText, setNewText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setItems(await listMemory());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load memory");
    } finally {
      setLoading(false);
    }
  }

  async function add() {
    const text = newText.trim();
    if (!text) return;
    setNewText("");
    try {
      await addMemory(text);
      refresh();
    } catch (err: any) {
      setError(err?.message ?? "Add failed");
    }
  }

  async function toggle(item: MemoryItem) {
    try {
      await updateMemory(item.id, { active: !item.active });
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, active: !i.active } : i))
      );
    } catch (err: any) {
      setError(err?.message ?? "Update failed");
    }
  }

  async function edit(item: MemoryItem) {
    const text = window.prompt("Edit fact:", item.text);
    if (text === null || !text.trim() || text.trim() === item.text) return;
    try {
      await updateMemory(item.id, { text: text.trim() });
      setItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, text: text.trim() } : i))
      );
    } catch (err: any) {
      setError(err?.message ?? "Update failed");
    }
  }

  return (
    <div className="memory-overlay">
      <div className="memory-panel">
        <div className="memory-header">
          <span className="topbar-title">Memory</span>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="memory-add">
          <input
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add a fact manually…"
          />
          <button className="primary" onClick={add} disabled={!newText.trim()}>
            Add
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {loading && <p className="empty-hint small">Loading…</p>}
        {!loading && items.length === 0 && (
          <p className="empty-hint small">
            No memories yet. Use "Remember" after a conversation.
          </p>
        )}

        <div className="memory-list">
          {items.map((item) => (
            <div
              key={item.id}
              className={`memory-item ${item.active ? "" : "inactive"}`}
            >
              <span
                className="memory-text"
                onClick={() => edit(item)}
                title="Tap to edit"
              >
                {item.text}
              </span>
              <button className="ghost" onClick={() => toggle(item)}>
                {item.active ? "Retire" : "Restore"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
