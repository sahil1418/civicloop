"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, ArrowUpRight, Loader2, MessageCircle, RotateCcw, X } from "lucide-react";

type Source = { id: string; label: string; href: string; retrievedAt: string; scope: "personal" | "public"; facts: { label: string; value: string }[] };
type Message = { role: "user" | "assistant"; content: string; sources?: Source[] };
type GuideStatus = { enabled: boolean; signedIn?: boolean; message: string; suggestions: string[] };

// Application routes are kept local; model output never supplies clickable URLs.
const LINKS = [
  { label: "Report an issue", href: "/report" },
  { label: "Live map", href: "/map" },
  { label: "My profile", href: "/profile" },
  { label: "Sign in", href: "/login" },
];

async function guideRequest(path: string, signal: AbortSignal, messages?: Message[]) {
  const base = process.env.NEXT_PUBLIC_API_BASE;
  if (!base) throw new Error("The guide cannot connect right now. Use the helpful pages below.");
  const response = await fetch(`${base.replace(/\/+$/, "")}/chatbot/${path}`, {
    method: messages ? "POST" : "GET",
    credentials: "include",
    cache: "no-store",
    signal,
    headers: { ...(messages ? { "Content-Type": "application/json" } : {}), ...(localStorage.getItem("civic_token") ? { Authorization: `Bearer ${localStorage.getItem("civic_token")}` } : {}) },
    body: messages ? JSON.stringify({ messages: messages.map(({ role, content }) => ({ role, content })) }) : undefined,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Please sign in again before retrieving your complaints.");
    if (response.status === 429) throw new Error("You’ve sent several questions. Please wait a minute and try again.");
    if (response.status === 504) throw new Error("The guide took too long to reply. Please try again.");
    throw new Error("The guide is temporarily unavailable. Please try again or use the pages below.");
  }
  return response;
}

function GuideDialog({ close }: { close: () => void }) {
  const [status, setStatus] = useState<GuideStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const activeRequest = useRef<AbortController | null>(null);
  const sending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let mounted = true;
    async function check() {
      setChecking(true);
      setError("");
      try {
        const response = await guideRequest("status", controller.signal);
        const result: GuideStatus = await response.json();
        if (mounted) setStatus(result);
      } catch (failure) {
        if (mounted) setError(failure instanceof Error ? failure.message : "The guide cannot connect right now. You can still use the pages below.");
      } finally {
        clearTimeout(timer);
        if (mounted) setChecking(false);
      }
    }
    void check();
    return () => { mounted = false; clearTimeout(timer); controller.abort(); };
  }, [checkAttempt]);

  useEffect(() => {
    dialog.current?.focus();
    return () => { activeRequest.current?.abort(); activeRequest.current = null; };
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [messages, busy, error]);

  useEffect(() => {
    // Restore focus after React has applied request/status changes to the form.
    if (!checking && status?.enabled) input.current?.focus();
  }, [busy, checking, status?.enabled]);

  async function send(question: string) {
    const content = question.trim();
    if (!content || sending.current || !status?.enabled || checking) return;
    const history: Message[] = [...messages, { role: "user", content }];
    sending.current = true;
    setBusy(true);
    setError("");
    setDraft("");
    setMessages(history);
    const controller = new AbortController();
    activeRequest.current = controller;
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
      // Only conversational text returns to the model; evidence is retrieved again.
      let context = history.slice(-9);
      while (context.length > 1 && context.reduce((size, message) => size + message.content.length, 0) > 10000) {
        context = context.slice(2);
      }
      const response = await guideRequest("messages", controller.signal, context);
      const result: { message: string; sources?: Source[] } = await response.json();
      if (typeof result.message !== "string" || !result.message.trim()) throw new Error("Empty reply");
      if (!controller.signal.aborted) setMessages([...history, { role: "assistant", content: result.message, sources: result.sources }]);
    } catch (failure) {
      if (activeRequest.current === controller) {
        // Failed turns are removed so retrying preserves user/assistant alternation.
        setMessages(history.slice(0, -1));
        setDraft(content);
        setError(controller.signal.aborted
          ? "The guide took too long to reply. Please try again."
          : failure instanceof Error ? failure.message : "Please try again shortly.");
      }
    } finally {
      clearTimeout(timer);
      sending.current = false;
      setBusy(false);
    }
  }

  function trapFocus(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab") return;
    const elements = dialog.current?.querySelectorAll<HTMLElement>("a[href], button:not(:disabled), textarea:not(:disabled)");
    if (!elements?.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
      event.preventDefault(); first.focus();
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-[10000] bg-black/40 backdrop-blur-sm" onClick={close} aria-hidden="true" />
      <section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="civic-guide-title"
        onKeyDown={trapFocus}
        className="fixed bottom-3 right-3 z-[10001] flex h-[min(680px,calc(100dvh-24px))] w-[calc(100vw-24px)] max-w-[420px] flex-col overflow-hidden rounded-3xl border border-white/15 bg-zinc-950 text-zinc-100 shadow-2xl shadow-black/60 outline-none sm:bottom-6 sm:right-6">
        <header className="flex items-center gap-3 border-b border-white/10 px-5 py-4">
          <div className="rounded-2xl bg-blue-500/15 p-2.5 text-blue-400"><MessageCircle size={21} aria-hidden="true" /></div>
          <div className="flex-1">
            <h2 id="civic-guide-title" className="font-semibold tracking-tight">CivicLoop Guide</h2>
            <p className="mt-0.5 text-xs text-zinc-400">A little help for a better city</p>
          </div>
          <button type="button" aria-label="Start a new chat" disabled={busy || messages.length === 0}
            onClick={() => { setMessages([]); setDraft(""); setError(""); input.current?.focus(); }}
            className="rounded-full p-2 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-30"><RotateCcw size={17} /></button>
          <button type="button" aria-label="Close CivicLoop Guide" onClick={close}
            className="rounded-full p-2 text-zinc-400 hover:bg-white/10 hover:text-white"><X size={20} /></button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {messages.length === 0 && (
            <div className="mb-6">
              <p className="text-2xl font-semibold leading-tight tracking-tight">Your city.<br /><span className="text-blue-400">Your questions, answered.</span></p>
              <p className="mt-3 text-sm leading-6 text-zinc-400">Check your complaint statuses, compare ward performance, or get help using CivicLoop.</p>
              {!checking && status?.enabled && <p className="mt-2 text-xs text-zinc-500">{status.signedIn ? "Signed in · retrieves your own reports" : "Sign in for personal reports · ward comparisons are public"}</p>}
              {!checking && status?.enabled && (
                <div className="mt-5 space-y-2">
                  {status.suggestions.map((question) => (
                    <button type="button" key={question} onClick={() => { void send(question); }}
                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-left text-sm text-zinc-200 transition hover:border-blue-500/50 hover:bg-blue-500/10">
                      {question}<ArrowUpRight size={15} className="shrink-0 text-blue-400" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions" className="space-y-4">
            {messages.map((message, index) => (
              <div key={index} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div className={`max-w-[95%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-blue-600 text-white" : "border border-white/10 bg-zinc-900 text-zinc-200"}`}>
                  <span className="sr-only">{message.role === "user" ? "You: " : "CivicLoop Guide: "}</span>
                  {message.content}
                  {message.sources && message.sources.length > 0 && (
                    <div className="mt-4 space-y-3 border-t border-white/10 pt-3">
                      <p className="text-xs font-semibold text-blue-300">Retrieved evidence</p>
                      {message.sources.map((source) => (
                        <details key={source.id} className="rounded-xl border border-white/10 bg-zinc-950/50 p-3" open={source.scope === "personal" || source.label.includes("performance")}>
                          <summary className="cursor-pointer text-xs font-medium text-zinc-200">[{source.id}] {source.label}</summary>
                          <dl className="mt-2 space-y-2 text-xs leading-5">
                            {source.facts.map((fact, index) => <div key={index}><dt className="font-medium text-zinc-300">{fact.label}</dt><dd className="text-zinc-400">{fact.value}</dd></div>)}
                          </dl>
                          <p className="mt-2 text-[10px] text-zinc-500">Retrieved {new Date(source.retrievedAt).toLocaleString()}</p>
                          <Link href={source.href} onClick={close} className="mt-1 inline-block text-xs text-blue-300 underline underline-offset-4">Open source page</Link>
                        </details>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          {busy && <p role="status" className="mt-4 flex items-center gap-2 text-sm text-zinc-400"><Loader2 size={15} className="animate-spin" />Thinking…</p>}
          {checking && <p role="status" className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 size={15} className="animate-spin" />Connecting to the guide…</p>}
          {!checking && status && !status.enabled && <p role="status" className="rounded-2xl border border-white/10 bg-zinc-900 p-4 text-sm leading-6 text-zinc-300">{status.message}</p>}
          {error && <div role="alert" className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm leading-6 text-amber-200">
            {error}
            {!status && <button type="button" onClick={() => setCheckAttempt((value) => value + 1)} className="mt-2 block underline underline-offset-4">Try connecting again</button>}
          </div>}
          <div ref={bottom} />
        </div>

        <footer className="border-t border-white/10 p-4">
          <nav aria-label="Helpful CivicLoop pages" className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-blue-300">
            {LINKS.map((link) => <Link key={link.href} href={link.href} onClick={close} className="hover:text-blue-200 hover:underline">{link.label}</Link>)}
          </nav>
          <form onSubmit={(event) => { event.preventDefault(); void send(draft); }}
            className="flex items-end gap-2 rounded-2xl border border-white/15 bg-zinc-900 p-2 focus-within:border-blue-500/70">
            <label htmlFor="civic-guide-question" className="sr-only">Your question about CivicLoop</label>
            <textarea ref={input} id="civic-guide-question" value={draft} onChange={(event) => setDraft(event.target.value)}
              rows={2} maxLength={1200} readOnly={busy} disabled={checking || !status?.enabled}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault(); void send(draft);
                }
              }}
              placeholder={status?.enabled ? "Ask about CivicLoop…" : "Chat is unavailable"}
              className="max-h-28 min-w-0 flex-1 resize-none bg-transparent px-2 py-1 text-sm leading-6 text-white outline-none placeholder:text-zinc-500 disabled:opacity-50" />
            <button type="submit" aria-label="Send question" disabled={!draft.trim() || busy || checking || !status?.enabled}
              className="rounded-xl bg-blue-600 p-2.5 text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-zinc-800 disabled:text-zinc-500"><ArrowUp size={18} /></button>
          </form>
          <p className="mt-2.5 text-[11px] leading-4 text-zinc-500">AI replies can be wrong. Questions and retrieved summaries go to the AI provider. Don’t share passwords. Chat clears when closed.</p>
        </footer>
      </section>
    </>
  );
}

export default function CivicGuide() {
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let token = localStorage.getItem("civic_token");
    const reset = () => { token = localStorage.getItem("civic_token"); setOpen(false); };
    const sync = () => { if (localStorage.getItem("civic_token") !== token) reset(); };
    window.addEventListener("authChanged", reset);
    window.addEventListener("storage", sync);
    window.addEventListener("focus", sync);
    return () => { window.removeEventListener("authChanged", reset); window.removeEventListener("storage", sync); window.removeEventListener("focus", sync); };
  }, []);
  function close() { setOpen(false); launcher.current?.focus(); }
  return (
    <>
      <button ref={launcher} type="button" aria-label="Open CivicLoop Guide" aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen(true)}
        className="fixed bottom-5 right-5 z-[9998] flex items-center gap-2 rounded-full border border-blue-400/30 bg-blue-600 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-blue-950/50 transition hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-400">
        <MessageCircle size={20} aria-hidden="true" /><span className="hidden sm:inline">Ask CivicLoop</span>
      </button>
      {open && <GuideDialog close={close} />}
    </>
  );
}
