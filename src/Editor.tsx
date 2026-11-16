import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Link,
  Download,
  MessageSquare,
  Scissors,
  Check,
  Send,
  Copy,
  Unlink,
  LoaderCircle,
  FileText,
  Eye,
  Star,
  Folder,
  Trash2,
  MoreHorizontal,
} from "lucide-react";
import { api, bytes, clock, mediaURL, type Clip } from "./types";
import { ShareSettings } from "./ShareSettings";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { usePlayback, trackCTA } from "./usePlayback";
import { StudioWorkbench, type WorkbenchHandle } from "./StudioWorkbench";
import { WatchPlayer } from "./WatchPlayer";
import { Menu, Modal, confirmDialog, tab as tabAttrs, tabPanel } from "./Modal";
import { Logo } from "./Logo";
// Groups transcript words into short phrases a viewer can read and jump to.
function phrases(words: { text: string; start: number }[]) {
  const out: { start: number; text: string }[] = [];
  let current: string[] = [],
    start = 0;
  words.forEach((w, i) => {
    if (!current.length) start = w.start;
    current.push(w.text.trim());
    const text = w.text.trim();
    if (
      i === words.length - 1 ||
      current.length >= 16 ||
      (current.length >= 5 && /[.!?]$/.test(text))
    ) {
      out.push({ start, text: current.join(" ") });
      current = [];
    }
  });
  return out;
}
// A link to this computer only opens here, so sending means downloading the file.
const localOnly = ["127.0.0.1", "localhost"].includes(location.hostname);
export function Editor({
  initial,
  token,
  onBack,
  onUpdate,
  onDelete,
  notify,
  embedded = false,
  readOnly = false,
}: {
  initial: Clip;
  token?: string;
  onBack: () => void;
  onUpdate: (v: Clip) => void;
  onDelete: () => void;
  notify: (s: string) => void;
  embedded?: boolean;
  readOnly?: boolean;
}) {
  const [clip, setClip] = useState(initial),
    [tab, setTab] = useState("activity"),
    [time, setTime] = useState(0),
    [name, setName] = useState(() => localStorage.getItem("relay-name") || ""),
    [comment, setComment] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [commentError, setCommentError] = useState(""),
    [sharing, setSharing] = useState(false),
    [pending, setPending] = useState(false),
    [title, setTitle] = useState(initial.title),
    [notes, setNotes] = useState(initial.description),
    [messageBusy, setMessageBusy] = useState(false),
    [replyTo, setReplyTo] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null),
    draft = useRef<WorkbenchHandle>(null);
  const canEdit = !token && !readOnly;
  const saveShare = useRef<() => Promise<boolean>>(async () => true);
  const [shareDirty, setShareDirty] = useState(false);
  useEffect(() => {
    document.title = `${clip.title} · Relay`;
    return () => {
      document.title = "Relay — Ideas worth sharing";
    };
  }, [clip.title]);
  usePlayback(player, clip, token);
  // Opening a video starts at its heading, for keyboards and screen readers.
  useEffect(() => {
    const heading = document.querySelector<HTMLElement>(".editor h1");
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (token && !sessionStorage.getItem(`view-${token}`)) {
      void api(`/api/share/${token}/view`, { method: "POST" })
        .then(() => sessionStorage.setItem(`view-${token}`, "1"))
        .catch(() => {});
    }
  }, [token]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        sharing ||
        (e.target as HTMLElement).closest(
          "input,textarea,select,button,a,video,summary,[role=dialog]",
        ) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      const step = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
      if (canEdit) {
        if (e.code === "Space") {
          e.preventDefault();
          draft.current?.toggle();
        } else if (step) {
          e.preventDefault();
          draft.current?.seek(draft.current.time() + step);
        }
        return;
      }
      const v = player.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      } else if (step) {
        e.preventDefault();
        v.currentTime = Math.max(
          0,
          Math.min(clip.duration, v.currentTime + step),
        );
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [clip.duration, sharing, canEdit]);
  const update = (v: Clip) => {
    setClip(v);
    onUpdate(v);
  };
  const mutate = async (body: unknown) => {
    try {
      const v = await api<Clip>(`/api/videos/${clip.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      update(v);
      notify("Changes saved");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const share = async () => {
    setError("");
    // On this computer a link is only made if you ask for the share page.
    if (localOnly) return setSharing(true);
    setBusy(true);
    try {
      if (!clip.token)
        update(
          await api<Clip>(`/api/videos/${clip.id}/share`, { method: "POST" }),
        );
      setSharing(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const createLink = async () => {
    if (clip.token) return;
    try {
      update(
        await api<Clip>(`/api/videos/${clip.id}/share`, { method: "POST" }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Puts the latest edits into the video without leaving the dialog.
  const [updating, setUpdating] = useState(false);
  const publishHere = async (thenDownload: boolean) => {
    setUpdating(true);
    try {
      const done = await draft.current?.publish();
      if (!done)
        return setError(
          "The video couldn’t be updated just now. Close this and try Update video again.",
        );
      if (thenDownload) location.href = `${mediaURL(clip, token)}?download=1`;
    } finally {
      setUpdating(false);
    }
  };
  // However the dialog is closed, what was typed in it is kept.
  const closeShare = async () => {
    if (await saveShare.current()) setSharing(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/s/${clip.token}`);
      notify("Share link copied");
    } catch {
      setError("Clipboard unavailable. Select and copy the link below.");
    }
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessageBusy(true);
    setCommentError("");
    try {
      const v = await api<Clip>(
        token
          ? `/api/share/${token}/comments`
          : `/api/videos/${clip.id}/comments`,
        {
          method: "POST",
          body: JSON.stringify({
            author: name,
            body: comment,
            time: Math.min(time, clip.duration),
            parentId: replyTo,
          }),
        },
      );
      localStorage.setItem("relay-name", name);
      update(v);
      setComment("");
      setReplyTo(null);
      notify("Comment posted");
    } catch (e) {
      setCommentError((e as Error).message);
    } finally {
      setMessageBusy(false);
    }
  };
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: "Delete this video?",
        body: "The recording, its comments and its share link will be permanently deleted.",
        confirm: "Delete video",
        cancel: "Keep video",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/videos/${clip.id}`, { method: "DELETE" });
      onDelete();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const seek = (n: number) => {
    if (canEdit) return draft.current?.seek(n);
    if (player.current) {
      player.current.currentTime = n;
      setTime(n);
    }
  };
  const react = async (emoji: string) => {
    if (!token) return;
    try {
      update(
        await api<Clip>(`/api/share/${token}/reactions`, {
          method: "POST",
          body: JSON.stringify({ emoji }),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div
      className={`editor ${token ? "public-editor" : ""} ${embedded ? "embedded-editor" : ""}`}
    >
      <header className="editor-header">
        {token ? (
          <span className="watch-brand">
            <Logo small />
          </span>
        ) : (
          <button className="text-button" onClick={onBack}>
            <ArrowLeft size={18} /> Library
          </button>
        )}
        {canEdit ? (
          <>
            <h1 className="sr-only">{clip.title}</h1>
            <input
              className="editable-title"
              aria-label="Video title"
              value={title}
              maxLength={160}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              onBlur={() => {
                if (title.trim() && title !== clip.title)
                  void mutate({ title });
                else setTitle(clip.title);
              }}
            />
          </>
        ) : (
          <span className="editor-breadcrumb" />
        )}
        <div className="actions">
          {canEdit && (
            <>
              <button
                className="icon-button"
                aria-label="Starred"
                title={clip.starred ? "Remove star" : "Star this video"}
                aria-pressed={!!clip.starred}
                onClick={() => void mutate({ starred: !clip.starred })}
              >
                <Star size={18} fill={clip.starred ? "currentColor" : "none"} />
              </button>
              <Menu label="More options">
                <label className="field small">
                  Collection
                  <input
                    aria-label="Collection"
                    placeholder="For example, Onboarding"
                    defaultValue={clip.folder}
                    maxLength={80}
                    onKeyDown={(e) =>
                      e.key === "Enter" && e.currentTarget.blur()
                    }
                    onBlur={(e) => {
                      if (e.target.value !== clip.folder)
                        void mutate({ folder: e.target.value });
                    }}
                  />
                </label>
                <p className="small muted">
                  {new Date(clip.created).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}{" "}
                  · {bytes(clip.size)} · {clip.views}{" "}
                  {clip.views === 1 ? "view" : "views"}
                </p>
                <button
                  className="text-button danger"
                  data-close
                  onClick={() => void remove()}
                >
                  <Trash2 size={15} />
                  Delete video
                </button>
              </Menu>
            </>
          )}
          {((!token && !readOnly) || clip.downloadAllowed !== false) && (
            <a
              className="btn"
              href={`${mediaURL(clip, token)}?download=1`}
              onClick={async (e) => {
                if (!canEdit || !pending) return;
                e.preventDefault();
                const href = e.currentTarget.href;
                if (
                  await confirmDialog({
                    title: "Download without your latest edits?",
                    body: "Your newest edits aren’t in the video file yet. Choose Update video first to include them.",
                    confirm: "Download anyway",
                  })
                )
                  location.href = href;
              }}
            >
              <Download size={16} />
              Download
            </a>
          )}
          {canEdit && (
            <button
              // While edits wait to be put in the video, that is the one main action.
              className={`btn ${pending ? "" : "primary"}`}
              disabled={busy}
              onClick={() => void share()}
            >
              <ArrowUpRight size={16} />
              {localOnly ? "Send" : "Share"}
            </button>
          )}
        </div>
      </header>
      <div className="editor-layout">
        <main className="editor-main">
          {!canEdit && (
            <>
              <WatchPlayer
                video={player}
                src={`${mediaURL(clip, token)}?v=${clip.revision || 0}`}
                duration={clip.duration}
                hasCaptions={!!clip.transcript?.length}
                label={clip.title}
                onTime={setTime}
                onReady={(v) => {
                  const t = Number(
                    new URLSearchParams(location.search).get("t"),
                  );
                  if (t > 0 && t < clip.duration) v.currentTime = t;
                }}
              >
                {clip.transcript?.length ? (
                  <track
                    key={`${clip.revision}-${clip.transcript.length}`}
                    kind="captions"
                    label="Transcript"
                    srcLang="en"
                    src={
                      token
                        ? `/api/share/${token}/captions.vtt`
                        : `/api/videos/${clip.id}/captions.vtt`
                    }
                  />
                ) : null}
              </WatchPlayer>
            </>
          )}
          {canEdit && (
            <StudioWorkbench
              ref={draft}
              onTime={setTime}
              onPending={setPending}
              clip={clip}
              onRendered={(v) => {
                update(v);
                setTitle(v.title);
              }}
              notify={notify}
            />
          )}
          {token && clip.cta?.url && (
            <a
              className="btn primary watch-cta"
              href={clip.cta.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => trackCTA(token)}
            >
              {clip.cta.label || "Next step"}
              <ArrowUpRight size={16} />
            </a>
          )}
          {!canEdit && (
            <div className="video-heading">
              <h1>{clip.title}</h1>
              <div className="clip-meta">
                {clip.author && (
                  <>
                    <span className="avatar owner">
                      {clip.author.trim()[0]?.toUpperCase()}
                    </span>
                    <strong>{clip.author}</strong>
                    <span>·</span>
                  </>
                )}
                <span>
                  {new Date(clip.created).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </span>
              </div>
            </div>
          )}
          {token && (
            <div
              className="reaction-bar"
              role="group"
              aria-label="React to this video"
            >
              {["❤️", "👏", "💡", "🎉"].map((emoji) => {
                const count = clip.reactions.find(
                  (r) => r.emoji === emoji,
                )?.count;
                return (
                  <button
                    key={emoji}
                    aria-label={`React with ${emoji}${count ? `, ${count} so far` : ""}`}
                    onClick={() => void react(emoji)}
                  >
                    {emoji}
                    {count ? <span>{count}</span> : null}
                  </button>
                );
              })}
            </div>
          )}
          {token && !!clip.transcript?.length && (
            <details className="transcript-public">
              <summary>Read the transcript</summary>
              <ol className="transcript-phrases">
                {phrases(clip.transcript).map((p) => (
                  <li key={p.start}>
                    <button onClick={() => seek(p.start)}>
                      <span>{clock(p.start)}</span>
                      {p.text}
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </main>
        <aside className="review-sidebar">
          <div
            className="review-tabs"
            role="tablist"
            aria-label="About this video"
          >
            <button
              {...tabAttrs(tab === "activity", "review-activity")}
              className={tab === "activity" ? "active" : ""}
              onClick={() => setTab("activity")}
            >
              <MessageSquare size={16} />
              Comments <span>{clip.comments.length}</span>
            </button>
            {(canEdit || clip.description || clip.outline?.summary) && (
              <button
                {...tabAttrs(tab === "notes", "review-notes")}
                className={tab === "notes" ? "active" : ""}
                onClick={() => setTab("notes")}
              >
                <FileText size={16} />
                Notes
              </button>
            )}
            {!token && !readOnly && (
              <button
                {...tabAttrs(tab === "analytics", "review-analytics")}
                className={tab === "analytics" ? "active" : ""}
                onClick={() => setTab("analytics")}
              >
                <Eye size={16} />
                Insights
              </button>
            )}
          </div>
          {tab === "activity" ? (
            <div className="review-panel" {...tabPanel("review-activity")}>
              <div className="comments">
                {clip.comments.length === 0 ? (
                  <div className="comment-empty">
                    <div className="empty-icon">
                      <MessageSquare size={25} strokeWidth={1.3} />
                    </div>
                    <h2>No comments yet</h2>
                    <p>
                      {token
                        ? "Pause where you have something to say and add a comment."
                        : "When viewers comment, you’ll see it here."}
                    </p>
                  </div>
                ) : (
                  clip.comments.map((c) => (
                    <article
                      className={`comment ${c.parentId ? "is-reply" : ""} ${c.resolved ? "is-resolved" : ""}`}
                      key={c.id}
                    >
                      <span className="avatar">
                        {c.author[0]?.toUpperCase()}
                      </span>
                      <div>
                        <strong>{c.author}</strong>
                        <button
                          className="timestamp"
                          aria-label={`Jump to ${clock(c.time)}`}
                          onClick={() => seek(c.time)}
                        >
                          {clock(c.time)}
                        </button>
                        <p>{c.body}</p>
                        <div className="comment-actions">
                          <button
                            className="text-button small"
                            aria-label={`Reply to ${c.author}`}
                            onClick={(e) => {
                              setReplyTo(c.id);
                              e.currentTarget
                                .closest(".review-panel")
                                ?.querySelector<HTMLElement>("textarea")
                                ?.focus();
                            }}
                          >
                            Reply
                          </button>
                          {!token && !readOnly && (
                            <button
                              className="text-button small"
                              onClick={async () => {
                                try {
                                  update(
                                    await api<Clip>(
                                      `/api/videos/${clip.id}/comments/${c.id}`,
                                      {
                                        method: "PATCH",
                                        body: JSON.stringify({
                                          resolved: !c.resolved,
                                        }),
                                      },
                                    ),
                                  );
                                } catch (e) {
                                  setError((e as Error).message);
                                }
                              }}
                            >
                              {c.resolved ? "Reopen" : "Resolve"}
                            </button>
                          )}
                          {!!c.resolved && <span>Resolved</span>}
                        </div>
                      </div>
                    </article>
                  ))
                )}
              </div>
              {!readOnly && (
                <form className="comment-form" onSubmit={(e) => void send(e)}>
                  {replyTo && (
                    <div className="reply-indicator">
                      Replying in thread
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setReplyTo(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <div className="comment-at">
                    <span className="tiny-dot" />
                    Comment at <b>{clock(time)}</b>
                  </div>
                  {token && (
                    <label className="small-label" htmlFor="comment-name">
                      Your name
                    </label>
                  )}
                  {token && (
                    <input
                      id="comment-name"
                      autoComplete="name"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={60}
                    />
                  )}
                  <label className="small-label" htmlFor="comment-body">
                    {replyTo ? "Your reply" : "Comment"}
                  </label>
                  <textarea
                    id="comment-body"
                    placeholder={`Add a comment at ${clock(time)}`}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    required
                    maxLength={2000}
                  />
                  <button
                    className="btn primary"
                    disabled={
                      messageBusy ||
                      (!!token && !name.trim()) ||
                      !comment.trim()
                    }
                  >
                    <Send size={15} />
                    {messageBusy ? "Sending…" : "Post comment"}
                  </button>
                  {commentError && (
                    <div className="error" role="alert">
                      {commentError}
                    </div>
                  )}
                </form>
              )}
              {readOnly && clip.token && (
                <a className="btn" href={`/s/${clip.token}`}>
                  Open the shared page to comment
                </a>
              )}
            </div>
          ) : (
            <div className="notes" {...tabPanel(`review-${tab}`)}>
              {tab === "analytics" ? (
                <AnalyticsPanel id={clip.id} />
              ) : (
                <>
                  {clip.outline?.summary && (
                    <>
                      <h2>Summary</h2>
                      <p className="notes-text">{clip.outline.summary}</p>
                      {clip.outline.chapters?.map((c, i) => (
                        <button
                          key={i}
                          className="chapter-link"
                          onClick={() => seek(c.time)}
                        >
                          <span>{clock(c.time)}</span>
                          {c.title}
                        </button>
                      ))}
                    </>
                  )}
                  <h2>Notes</h2>
                  {token || readOnly ? (
                    <p className="notes-text">
                      {clip.description || "No notes added to this video yet."}
                    </p>
                  ) : (
                    <>
                      <textarea
                        aria-label="Video notes"
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        maxLength={20000}
                        placeholder="Key takeaways, helpful links, next steps…"
                        onBlur={() => {
                          if (notes !== clip.description)
                            void mutate({ description: notes });
                        }}
                      />
                      <p className="muted small" role="status">
                        {notes === clip.description
                          ? "Saved. Viewers see these notes next to the video."
                          : "Saves when you click away."}
                      </p>
                    </>
                  )}
                </>
              )}{" "}
            </div>
          )}
          {token && (
            <div className="review-footer">
              <span>Made with</span>
              <Logo small />
            </div>
          )}
        </aside>
      </div>
      {sharing && (
        <Modal
          label={localOnly ? "Send this video" : "Share this video"}
          className="share-dialog"
          onClose={() => void closeShare()}
        >
          <h2>{localOnly ? "Send this video" : "Share this video"}</h2>
          {(pending || updating) && !localOnly && (
            <div className="share-note warn" role="status">
              <span>
                {updating
                  ? "Putting your latest edits into the video…"
                  : "Your latest edits aren’t in the shared video yet."}
              </span>
              <button
                className="btn"
                disabled={updating}
                onClick={() => void publishHere(false)}
              >
                {updating ? "Updating…" : "Update video"}
              </button>
            </div>
          )}
          {localOnly ? (
            <>
              <p className="share-note">
                Relay is running only on this computer, so a link wouldn’t open
                for anyone else. Download the video and send the file.
              </p>
              {pending || updating ? (
                <div className="share-actions" role="status">
                  <button
                    className="btn primary"
                    disabled={updating}
                    onClick={() => void publishHere(true)}
                  >
                    <Download size={16} />
                    {updating
                      ? "Putting your edits in…"
                      : "Update and download"}
                  </button>
                  {!updating && (
                    <a
                      className="text-button"
                      href={`${mediaURL(clip, token)}?download=1`}
                    >
                      Download without my latest edits
                    </a>
                  )}
                </div>
              ) : (
                <a
                  className="btn primary share-download"
                  href={`${mediaURL(clip, token)}?download=1`}
                >
                  <Download size={16} />
                  Download video
                </a>
              )}
              <details
                className="cut-more share-local"
                onToggle={(e) => {
                  if (e.currentTarget.open) void createLink();
                }}
              >
                <summary>Share page on this computer</summary>
                <div className="cut-more-body">
                  {!clip.token && (
                    <p className="small muted" role="status">
                      Creating the page…
                    </p>
                  )}
                  {clip.token && (
                    <>
                      <label className="share-link">
                        <Link size={18} />
                        <input
                          aria-label="Share link"
                          readOnly
                          value={`${location.origin}/s/${clip.token}`}
                          onFocus={(e) => e.target.select()}
                        />
                        <button className="btn" onClick={() => void copy()}>
                          <Copy size={14} />
                          Copy link
                        </button>
                      </label>
                      <ShareSettings
                        clip={clip}
                        onChange={update}
                        notify={notify}
                        time={time}
                        saveRef={saveShare}
                        onDirty={setShareDirty}
                      />
                    </>
                  )}
                </div>
              </details>
            </>
          ) : (
            <>
              <label className="share-link">
                <Link size={18} />
                <input
                  aria-label="Share link"
                  readOnly
                  value={`${location.origin}/s/${clip.token}`}
                  onFocus={(e) => e.target.select()}
                />
                <button className="btn primary" onClick={() => void copy()}>
                  <Copy size={14} />
                  Copy link
                </button>
              </label>
              <ShareSettings
                clip={clip}
                onChange={update}
                notify={notify}
                time={time}
                saveRef={saveShare}
                onDirty={setShareDirty}
              />
            </>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="dialog-footer">
            <button
              className="text-button danger"
              hidden={!clip.token}
              onClick={async () => {
                if (
                  !(await confirmDialog({
                    title: "Turn off this link?",
                    body: "Anyone who has the link will no longer be able to watch. You can create a new link later.",
                    confirm: "Turn off link",
                    destructive: true,
                  }))
                )
                  return;
                try {
                  await api(`/api/videos/${clip.id}/share`, {
                    method: "DELETE",
                  });
                  update({ ...clip, token: null });
                  setSharing(false);
                  notify("Share link turned off");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <Unlink size={15} />
              Turn off link
            </button>
            <button className="btn" onClick={() => void closeShare()}>
              {shareDirty ? "Save and close" : "Done"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
