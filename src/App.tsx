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
  const scrollRef = useRef<HTMLDivElement>(null);

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
