import { useEffect, useMemo, useRef, useState } from "react";
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
  getMe,
  setPinned,
  listAllowlist,
  addToAllowlist,
  removeFromAllowlist,
  type ChatMessage,
  type ConversationSummary,
  type MemoryItem,
  type ModelAlias,
  type Me,
  type AllowlistEntry,
} from "./api";

marked.setOptions({ breaks: true });

function renderMarkdown(content: string): { __html: string } {
  const html = marked.parse(content, { async: false }) as string;
  return { __html: DOMPurify.sanitize(html) };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function fileToCompressedDataUrl(file: File, maxDim = 1024): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.8);
}

// ---------- Code sandbox helpers ----------

interface RunnableBlock {
  lang: "html" | "js";
  code: string;
  label: string;
}

function extractRunnableBlocks(content: string): RunnableBlock[] {
  const blocks: RunnableBlock[] = [];
  const re = /```(\w+)?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let htmlCount = 0;
  let jsCount = 0;

  while ((match = re.exec(content)) !== null) {
    const lang = (match[1] ?? "").toLowerCase();
    const code = match[2];
    if (!code.trim()) continue;

    if (lang === "html") {
      htmlCount++;
      blocks.push({
        lang: "html",
        code,
        label: htmlCount > 1 ? `Run HTML #${htmlCount}` : "Run HTML",
      });
    } else if (lang === "js" || lang === "javascript") {
      jsCount++;
      blocks.push({
        lang: "js",
        code,
        label: jsCount > 1 ? `Run JS #${jsCount}` : "Run JS",
      });
    }
  }
  return blocks;
}

const SANDBOX_HARNESS = `<script>
(function () {
  function fmt(a) {
    try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
    catch { return String(a); }
  }
  function send(level, args) {
    parent.postMessage(
      { __sandbox: true, level: level, text: Array.prototype.map.call(args, fmt).join(" ") },
      "*"
    );
  }
  ["log", "info", "warn", "error"].forEach(function (l) {
    var orig = console[l];
    console[l] = function () { send(l, arguments); orig.apply(console, arguments); };
  });
  window.addEventListener("error", function (e) {
    send("error", [e.message + " (line " + e.lineno + ")"]);
  });
  window.addEventListener("unhandledrejection", function (e) {
    send("error", ["Unhandled promise rejection: " + fmt(e.reason)]);
  });
})();
<\/script>`;

function buildSrcDoc(block: RunnableBlock): string {
  if (block.lang === "html") {
    // Prepend the harness so console capture is active before user code runs
    return SANDBOX_HARNESS + "\n" + block.code;
  }
  // Plain JS: wrap in a minimal shell. Escape any </script> inside the code.
  const safe = block.code.replace(/<\/script>/gi, "<\\/script>");
  return (
    "<!DOCTYPE html><html><head>" +
    SANDBOX_HARNESS +
    '</head><body style="margin:0;background:#fff;color:#111;font-family:monospace"><script>' +
    safe +
    "<\\/script></body></html>"
  );
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
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState("");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [remembering, setRemembering] = useState(false);
  const [rememberResult, setRememberResult] = useState<string>("");
  const [searchStatus, setSearchStatus] = useState("");
  const [proMode, setProMode] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [sandboxBlock, setSandboxBlock] = useState<RunnableBlock | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    (async () => {
      try {
        setMe(await getMe());
        await refreshConversations();
      } catch (err: any) {
        setMeError(err?.message ?? "Unable to load account");
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, searchStatus]);

  // Auto-resize the textarea based on its content
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

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
    setPendingImage(null);
    setDrawerOpen(false);
  }

  async function togglePin(c: ConversationSummary, e: React.MouseEvent) {
    e.stopPropagation();
    // Optimistic update, revert on failure
    const next = !c.pinned;
    setConversations((prev) => {
      const updated = prev.map((x) => (x.id === c.id ? { ...x, pinned: next } : x));
      updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
      });
      return updated;
    });
    try {
      await setPinned(c.id, next);
    } catch (err: any) {
      setError(err?.message ?? "Pin failed");
      refreshConversations();
    }
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

  async function attachImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setError("");
    try {
      const dataUrl = await fileToCompressedDataUrl(file);
      if (dataUrl.length > 850_000) {
        setError("Image too large even after compression — try a smaller one.");
        return;
      }
      setPendingImage(dataUrl);
    } catch {
      setError("Could not read that image.");
    }
  }

  async function send() {
    const text = input.trim();
    if ((!text && !pendingImage) || busy) return;

    setError("");
    setRememberResult("");
    setSearchStatus("");
    setInput("");
    setBusy(true);

    const model: ModelAlias = proMode ? "pro" : "default";
    const imageToSend = pendingImage;
    setPendingImage(null);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, image: imageToSend },
      { role: "assistant", content: "" },
    ]);

    try {
      const returnedId = await streamChat(
        text,
        activeId,
        (delta) => {
          setSearchStatus("");
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, content: last.content + delta };
            return next;
          });
        },
        model,
        (query) => setSearchStatus(`Searching the web: "${query}"…`),
        (sources) =>
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            next[next.length - 1] = { ...last, sources };
            return next;
          }),
        imageToSend
      );

      if (!activeId && returnedId) setActiveId(returnedId);
      refreshConversations();
    } catch (err: any) {
      setError(err?.message ?? "Something went wrong");
      setMessages((prev) =>
        prev[prev.length - 1]?.content === "" ? prev.slice(0, -1) : prev
      );
    } finally {
      setBusy(false);
      setSearchStatus("");
    }
  }

  // Signed in with Google but rejected by the backend
  if (meError) {
    return (
      <div className="centered">
        <div className="signin-card">
          <h1>Not authorized</h1>
          <p className="empty-hint small" style={{ marginBottom: "1.25rem" }}>
            {meError}
          </p>
          <button className="ghost full" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </div>
    );
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
        {me?.role === "admin" && (
          <button
            className="ghost full"
            onClick={() => {
              setDrawerOpen(false);
              setAdminOpen(true);
            }}
          >
            👥 Manage users
          </button>
        )}
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
              <span className="conv-title">
                {c.pinned && <span className="pin-mark">📌 </span>}
                {c.title}
              </span>
              <button
                className="ghost icon small"
                onClick={(e) => togglePin(c, e)}
                title={c.pinned ? "Unpin" : "Pin"}
              >
                {c.pinned ? "📌" : "📍"}
              </button>
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
        {messages.map((m, i) => {
          const runnables =
            m.role === "assistant" && m.content
              ? extractRunnableBlocks(m.content)
              : [];
          return (
            <div key={i} className={`bubble ${m.role}`}>
              {m.role === "assistant" ? (
                m.content ? (
                  <>
                    <div
                      className="md"
                      dangerouslySetInnerHTML={renderMarkdown(m.content)}
                    />
                    {runnables.length > 0 && (
                      <div className="sources">
                        {runnables.map((b, bi) => (
                          <button
                            key={bi}
                            className="source-chip run-chip"
                            onClick={() => setSandboxBlock(b)}
                          >
                            ▶ {b.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {m.sources && m.sources.length > 0 && (
                      <div className="sources">
                        {m.sources.map((s, si) => (
                          
                            key={si}
                            className="source-chip"
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={s.title}
                          >
                            {hostnameOf(s.url)}
                          </a>
                        ))}
                      </div>
                    )}
                  </>
                ) : busy && i === messages.length - 1 ? (
                  <span className="typing">
                    <span />
                    <span />
                    <span />
                  </span>
                ) : (
                  ""
                )
              ) : (
                <>
                  {m.image && (
                    <img className="bubble-img" src={m.image} alt="attachment" />
                  )}
                  {m.content}
                </>
              )}
            </div>
          );
        })}
        {error && <p className="error">{error}</p>}
        {rememberResult && <p className="empty-hint small">{rememberResult}</p>}
        {searchStatus && <p className="empty-hint small">🔍 {searchStatus}</p>}
      </div>

      <div className="composer">
        {pendingImage && (
          <div className="attach-preview">
            <img src={pendingImage} alt="pending attachment" />
            <button
              className="ghost icon small"
              onClick={() => setPendingImage(null)}
            >
              ×
            </button>
          </div>
        )}
        <button
          className="ghost model-toggle"
          onClick={() => fileInputRef.current?.click()}
          title="Attach an image"
        >
          📷
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={attachImage}
        />
        <button
          className={`ghost model-toggle ${proMode ? "pro-on" : ""}`}
          onClick={() => setProMode((p) => !p)}
          title={proMode ? "Pro model on (limited daily quota)" : "Using fast model"}
        >
          {proMode ? "PRO" : "fast"}
        </button>
        <textarea
          ref={textareaRef}
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
          style={{ overflowY: "auto" }}
        />
        <button
          className="primary"
          onClick={send}
          disabled={busy || (!input.trim() && !pendingImage)}
        >
          Send
        </button>
      </div>

      {memoryOpen && <MemoryPanel onClose={() => setMemoryOpen(false)} />}
      {adminOpen && (
        <AdminPanel selfEmail={me?.email ?? ""} onClose={() => setAdminOpen(false)} />
      )}
      {sandboxBlock && (
        <SandboxPanel block={sandboxBlock} onClose={() => setSandboxBlock(null)} />
      )}
    </div>
  );
}

function SandboxPanel({
  block,
  onClose,
}: {
  block: RunnableBlock;
  onClose: () => void;
}) {
  const [logs, setLogs] = useState<Array<{ level: string; text: string }>>([]);
  const [nonce, setNonce] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MessageEvent) {
      if (e.data?.__sandbox) {
        setLogs((prev) => [
          ...prev.slice(-199),
          { level: String(e.data.level), text: String(e.data.text) },
        ]);
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [logs]);

  const srcDoc = useMemo(() => buildSrcDoc(block), [block, nonce]);

  function reload() {
    setLogs([]);
    setNonce((n) => n + 1);
  }

  return (
    <div className="memory-overlay">
      <div className="memory-panel sandbox-panel">
        <div className="memory-header">
          <span className="topbar-title">▶ Sandbox</span>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="ghost" onClick={reload}>
              Reload
            </button>
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <iframe
          key={nonce}
          className="sandbox-frame"
          sandbox="allow-scripts"
          srcDoc={srcDoc}
          title="Code sandbox"
        />

        <div className="sandbox-console" ref={logRef}>
          {logs.length === 0 && (
            <div className="console-line dim">Console output appears here…</div>
          )}
          {logs.map((l, i) => (
            <div key={i} className={`console-line ${l.level}`}>
              {l.text}
            </div>
          ))}
        </div>
      </div>
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

function AdminPanel({
  selfEmail,
  onClose,
}: {
  selfEmail: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<AllowlistEntry[]>([]);
  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setEntries(await listAllowlist());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load users");
    } finally {
      setLoading(false);
    }
  }

  async function add() {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) return;
    setError("");
    try {
      await addToAllowlist(email, newRole);
      setNewEmail("");
      setNewRole("user");
      refresh();
    } catch (err: any) {
      setError(err?.message ?? "Add failed");
    }
  }

  async function remove(email: string) {
    if (email === selfEmail) return;
    if (!window.confirm(`Remove ${email}? They will lose access immediately.`))
      return;
    setError("");
    try {
      await removeFromAllowlist(email);
      setEntries((prev) => prev.filter((e) => e.email !== email));
    } catch (err: any) {
      setError(err?.message ?? "Remove failed");
    }
  }

  return (
    <div className="memory-overlay">
      <div className="memory-panel">
        <div className="memory-header">
          <span className="topbar-title">Users</span>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="memory-add">
          <input
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="email@example.com"
            type="email"
          />
          <button
            className={`ghost role-toggle ${newRole === "admin" ? "pro-on" : ""}`}
            onClick={() => setNewRole((r) => (r === "user" ? "admin" : "user"))}
            title="Toggle role for the new user"
          >
            {newRole}
          </button>
          <button className="primary" onClick={add} disabled={!newEmail.includes("@")}>
            Add
          </button>
        </div>

        {error && <p className="error">{error}</p>}
        {loading && <p className="empty-hint small">Loading…</p>}

        <div className="memory-list">
          {entries.map((entry) => (
            <div key={entry.email} className="memory-item">
              <span className="memory-text" style={{ cursor: "default" }}>
                {entry.email}
                {entry.role === "admin" && <span className="role-badge"> admin</span>}
                {entry.email === selfEmail && <span className="role-badge you"> you</span>}
              </span>
              {entry.email !== selfEmail && (
                <button className="ghost" onClick={() => remove(entry.email)}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
