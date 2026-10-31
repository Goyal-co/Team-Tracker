import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Paperclip, SendHorizontal, Smile } from "lucide-react";
import { commentParts } from "../domain/format";
import type { User, WorkspaceMessage } from "../domain/types";
import { cn, fileMime, fileToBase64 } from "../lib";
import { TextInput } from "./ui";

const EMOJI = ["😀", "😁", "😂", "😊", "😍", "🙏", "👍", "👏", "🎉", "✅", "🔥", "❤️", "💡", "📌", "📅", "👋", "😅", "🤔", "👀", "🚀"];

export function MessageBody({ message, mine, users = [], onMention }: { message: WorkspaceMessage; mine: boolean; users?: User[]; onMention?: (userId: string) => void }) {
  const image = Boolean(message.Storage_Ref) && (message.Mime_Type || "").startsWith("image/");
  const file = Boolean(message.Storage_Ref) && !image;
  return (
    <div className={`mt-0.5 block w-fit max-w-full rounded-2xl px-3 py-2 text-left text-[13px] leading-5 ${mine ? "rounded-br-md bg-accent text-white" : "rounded-bl-md border border-line bg-white shadow-sm"}`}>
      {message.Body && (
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          {commentParts(message.Body, users).map((part, index) =>
            part.kind === "mention" ? (
              <button key={`${part.userId}-${index}`} type="button" className={`font-semibold underline ${mine ? "text-white" : "text-accent"}`} onClick={() => onMention?.(part.userId)}>@{part.label}</button>
            ) : part.kind === "link" ? (
              <a key={index} href={part.href} target="_blank" rel="noopener noreferrer" className={`break-all underline ${mine ? "text-white" : "text-accent"}`}>{part.label}</a>
            ) : (
              <span key={index}>{part.value}</span>
            ),
          )}
        </p>
      )}
      {image && (
        <a href={`/api/messages/${message.Message_ID}/file`} target="_blank" rel="noreferrer">
          <img src={`/api/messages/${message.Message_ID}/file`} alt={message.File_Name || "Image"} className="mt-1 max-h-52 rounded-lg" />
        </a>
      )}
      {file && (
        <a className={`mt-1 block underline ${mine ? "text-white" : "text-accent"}`} href={`/api/messages/${message.Message_ID}/file`}>
          {message.File_Name || "Attachment"}
        </a>
      )}
    </div>
  );
}

export function Composer({
  placeholder,
  disabled,
  mentions = [],
  onSend,
}: {
  placeholder: string;
  disabled?: boolean;
  mentions?: User[];
  onSend: (body: string, file?: { File_Name: string; Mime_Type: string; Content_Base64: string }) => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [hideMentions, setHideMentions] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const mentionQuery = draft.slice(0, caret).match(/(?:^|\s)@([^\n@]*)$/)?.[1] ?? null;
  const suggestions = mentionQuery === null || hideMentions || mentionQuery.trim().length < 2
    ? []
    : mentions.filter((user) => user.Name.toLowerCase().includes(mentionQuery.trim().toLowerCase())).slice(0, 6);

  useEffect(() => {
    if (!emoji && suggestions.length === 0) return;
    const onPointer = (event: MouseEvent) => {
      if (!popRef.current?.contains(event.target as Node)) {
        setEmoji(false);
        setHideMentions(true);
      }
    };
    window.addEventListener("mousedown", onPointer);
    return () => window.removeEventListener("mousedown", onPointer);
  }, [emoji, suggestions.length]);

  function rememberCaret(target: HTMLInputElement) {
    setCaret(target.selectionStart ?? target.value.length);
  }

  function matchesFor(value: string, cursor: number) {
    const query = value.slice(0, cursor).match(/(?:^|\s)@([^\n@]*)$/)?.[1] ?? null;
    if (query === null || query.trim().length < 2) return [];
    return mentions.filter((user) => user.Name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 6);
  }

  function insertMention(user: User, value = draft, cursor = caret) {
    const before = value.slice(0, cursor).replace(/(?:^|\s)@([^\n@]*)$/, (match) => `${match.startsWith(" ") ? " " : ""}@[${user.Name}](${user.User_ID}) `);
    setDraft(`${before}${value.slice(cursor)}`);
    setCaret(before.length);
    setActive(0);
    setHideMentions(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const value = event.currentTarget.value;
    const cursor = event.currentTarget.selectionStart ?? value.length;
    const matches = matchesFor(value, cursor);
    if (!matches.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(matches[Math.min(active, matches.length - 1)], value, cursor);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setHideMentions(true);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (disabled || busy || (!body && !file)) return;
    setBusy(true);
    try {
      const attached = file
        ? { File_Name: file.name, Mime_Type: fileMime(file), Content_Base64: await fileToBase64(file) }
        : undefined;
      await onSend(body, attached);
      setDraft("");
      setFile(null);
      setEmoji(false);
    } finally {
      setBusy(false);
    }
  }

  const canSend = !disabled && !busy && Boolean(draft.trim() || file);

  return (
    <form className="bg-white px-2 py-2 sm:px-3" onSubmit={(event) => void submit(event)}>
      {file && (
        <div className="mb-2 flex items-center justify-between rounded-lg bg-canvas px-2.5 py-1.5 text-[12px]">
          <span className="truncate">{file.name}</span>
          <button type="button" className="shrink-0 text-muted" onClick={() => setFile(null)}>Remove</button>
        </div>
      )}
      <div ref={popRef} className="relative flex items-end gap-1">
        {suggestions.length > 0 && (
          <ul className="absolute bottom-full left-10 z-20 mb-2 w-64 overflow-hidden rounded-lg border border-line bg-white shadow-lg">
            {suggestions.map((user, index) => (
              <li key={user.User_ID}>
                <button
                  type="button"
                  className={`block w-full px-3 py-2 text-left text-[13px] ${index === active ? "bg-accent-soft" : "hover:bg-canvas"}`}
                  onMouseDown={(event) => { event.preventDefault(); insertMention(user); }}
                >
                  {user.Name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="relative shrink-0">
          <button type="button" aria-label="Emoji" className="inline-flex h-9 w-9 items-center justify-center rounded-full text-muted hover:bg-canvas" disabled={disabled} onClick={() => setEmoji((open) => !open)}>
            <Smile size={18} />
          </button>
          {emoji && (
            <div className="absolute bottom-11 left-0 z-20 grid w-56 grid-cols-5 gap-1 rounded-lg border border-line bg-white p-2 shadow-lg">
              {EMOJI.map((item) => (
                <button key={item} type="button" className="rounded p-1 text-[18px] hover:bg-canvas" onClick={() => { setDraft((value) => value + item); setEmoji(false); }}>
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" aria-label="Attach a file" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted hover:bg-canvas" disabled={disabled} onClick={() => picker.current?.click()}>
          <Paperclip size={18} />
        </button>
        <input
          ref={picker}
          type="file"
          className="hidden"
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain,text/csv,.docx,.xlsx,.pptx"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
        <TextInput
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          enterKeyHint="send"
          autoComplete="off"
          className="min-h-9 flex-1 rounded-full border-line bg-canvas px-3.5"
          onChange={(event) => { setDraft(event.target.value); rememberCaret(event.target); setActive(0); setHideMentions(false); }}
          onSelect={(event) => rememberCaret(event.currentTarget)}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          aria-label="Send message"
          disabled={!canSend}
          className={cn(
            "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition",
            canSend ? "bg-accent text-white hover:bg-[#0055cc]" : "bg-slate-200 text-slate-400",
          )}
        >
          <SendHorizontal size={16} strokeWidth={2.25} className={canSend ? "translate-x-px" : undefined} />
        </button>
      </div>
    </form>
  );
}
