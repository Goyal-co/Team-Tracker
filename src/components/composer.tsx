import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Paperclip, Smile } from "lucide-react";
import { commentParts } from "../domain/format";
import type { User, WorkspaceMessage } from "../domain/types";
import { fileMime, fileToBase64 } from "../lib";
import { Button, TextInput } from "./ui";

const EMOJI = ["😀", "😁", "😂", "😊", "😍", "🙏", "👍", "👏", "🎉", "✅", "🔥", "❤️", "💡", "📌", "📅", "👋", "😅", "🤔", "👀", "🚀"];

export function MessageBody({ message, mine, users = [], onMention }: { message: WorkspaceMessage; mine: boolean; users?: User[]; onMention?: (userId: string) => void }) {
  const image = Boolean(message.Storage_Ref) && (message.Mime_Type || "").startsWith("image/");
  const file = Boolean(message.Storage_Ref) && !image;
  return (
    <div className={`mt-0.5 block w-fit max-w-full rounded-2xl px-3 py-2 text-left text-[13px] leading-5 ${mine ? "rounded-br-md bg-accent text-white" : "rounded-bl-md bg-white shadow-sm"}`}>
      {message.Body && (
        <p className="whitespace-pre-wrap break-words">
          {commentParts(message.Body, users).map((part, index) =>
            part.kind === "mention" ? (
              <button key={`${part.userId}-${index}`} type="button" className={`font-semibold underline ${mine ? "text-white" : "text-accent"}`} onClick={() => onMention?.(part.userId)}>@{part.label}</button>
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
  const mentionQuery = draft.slice(0, caret).match(/(?:^|\s)@([^\n@]*)$/)?.[1] ?? null;
  const suggestions = mentionQuery === null || hideMentions
    ? []
    : mentions.filter((user) => user.Name.toLowerCase().includes(mentionQuery.trim().toLowerCase())).slice(0, 6);

  function rememberCaret(target: HTMLInputElement) {
    setCaret(target.selectionStart ?? target.value.length);
  }

  function insertMention(user: User) {
    const before = draft.slice(0, caret).replace(/(?:^|\s)@([^\n@]*)$/, (match) => `${match.startsWith(" ") ? " " : ""}@[${user.Name}](${user.User_ID}) `);
    setDraft(`${before}${draft.slice(caret)}`);
    setCaret(before.length);
    setActive(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!suggestions.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => (index + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      insertMention(suggestions[Math.min(active, suggestions.length - 1)]);
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

  return (
    <form className="border-t border-line bg-white p-3" onSubmit={(event) => void submit(event)}>
      {file && (
        <div className="mb-2 flex items-center justify-between rounded-md bg-canvas px-2 py-1 text-[12px]">
          <span className="truncate">{file.name}</span>
          <button type="button" className="text-muted" onClick={() => setFile(null)}>Remove</button>
        </div>
      )}
      <div className="relative flex items-center gap-1">
        {suggestions.length > 0 && (
          <ul className="absolute bottom-full left-16 z-20 mb-2 w-64 overflow-hidden rounded-lg border border-line bg-white shadow-lg">
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
        <div className="relative">
          <button type="button" aria-label="Emoji" className="rounded-md p-2 text-muted hover:bg-canvas" disabled={disabled} onClick={() => setEmoji((open) => !open)}>
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
        <button type="button" aria-label="Attach a file" className="rounded-md p-2 text-muted hover:bg-canvas" disabled={disabled} onClick={() => picker.current?.click()}>
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
          className="w-full"
          onChange={(event) => { setDraft(event.target.value); rememberCaret(event.target); setActive(0); setHideMentions(false); }}
          onSelect={(event) => rememberCaret(event.currentTarget)}
          onKeyDown={onKeyDown}
        />
        <Button type="submit" disabled={disabled || busy || (!draft.trim() && !file)}>Send</Button>
      </div>
    </form>
  );
}
