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
} from "lucide-react";
import { api, bytes, clock, mediaURL, type Clip } from "./types";
import { FrameStrip } from "./FrameStrip";
import { ShareSettings } from "./ShareSettings";
import { AnalyticsPanel } from "./AnalyticsPanel";
import { usePlayback, trackCTA } from "./usePlayback";
import { StudioWorkbench } from "./StudioWorkbench";
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
    [sharing, setSharing] = useState(false),
    [trim, setTrim] = useState(false),
    [start, setStart] = useState(0),
    [end, setEnd] = useState(initial.duration),
    [title, setTitle] = useState(initial.title),
    [notes, setNotes] = useState(initial.description),
    [confirmDelete, setConfirmDelete] = useState(false),
    [speed, setSpeed] = useState("1"),
    [messageBusy, setMessageBusy] = useState(false),
    [replyTo, setReplyTo] = useState<string | null>(null);
  const player = useRef<HTMLVideoElement>(null);
  usePlayback(player, clip, token);
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
        confirmDelete ||
        (e.target as HTMLElement).closest(
          "input,textarea,select,button,video",
        ) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      )
        return;
      const v = player.current;
      if (!v) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (v.paused) void v.play().catch(() => {});
        else v.pause();
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        v.currentTime = Math.max(
          0,
          Math.min(
            clip.duration,
            v.currentTime + (e.key === "ArrowRight" ? 5 : -5),
          ),
        );
      }
      if (!token && !readOnly && e.key.toLowerCase() === "i") {
        setTrim(true);
        setStart(Math.min(v.currentTime, end - 0.1));
      }
      if (!token && !readOnly && e.key.toLowerCase() === "o") {
        setTrim(true);
        setEnd(Math.max(v.currentTime, start + 0.1));
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [clip.duration, sharing, confirmDelete, token, start, end]);
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
    setError("");
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
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMessageBusy(false);
    }
  };
  const exportTrim = async () => {
    setBusy(true);
    setError("");
    try {
      const v = await api<Clip>(`/api/videos/${clip.id}/trim`, {
        method: "POST",
        body: JSON.stringify({ start, end }),
      });
      notify("Trimmed copy saved to your library");
      onUpdate(v);
      setTrim(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const seek = (n: number) => {
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
        <button className="text-button" onClick={onBack}>
          {token ? (
            <span className="wordmark mini">◒ relay</span>
          ) : (
            <>
              <ArrowLeft size={18} /> Your library
            </>
          )}
        </button>
        <span className="editor-breadcrumb">
          {token
            ? "A little context, sent your way."
            : "Workspace / Video editor"}
        </span>
        <div className="actions">
          {((!token && !readOnly) || clip.downloadAllowed !== false) && (
            <a className="btn" href={`${mediaURL(clip, token)}?download=1`}>
              <Download size={16} />
              Download
            </a>
          )}
          {!token && !readOnly && (
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => void share()}
            >
              <ArrowUpRight size={16} />
              Share video
            </button>
          )}
        </div>
      </header>
      <div className="editor-layout">
        <main className="editor-main">
          <div className="video-player">
            <video
              ref={player}
              src={`${mediaURL(clip, token)}?v=${clip.revision || 0}`}
              poster={clip.thumbnail || undefined}
              controls
              playsInline
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onLoadedMetadata={() => {
                if (player.current) {
                  player.current.playbackRate = Number(speed);
                  const t = Number(
                    new URLSearchParams(location.search).get("t"),
                  );
                  if (t > 0 && t < clip.duration)
                    player.current.currentTime = t;
                }
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
            </video>
            <span className="player-brand">relay</span>
          </div>
          <div className="player-tools">
            <span>
              <span className="tiny-dot" />
              {clock(time)}{" "}
              <span className="muted">/ {clock(clip.duration)}</span>
            </span>
            <div className="actions">
              <label className="small">
                Speed{" "}
                <select
                  aria-label="Playback speed"
                  value={speed}
                  onChange={(e) => {
                    setSpeed(e.target.value);
                    if (player.current)
                      player.current.playbackRate = Number(e.target.value);
                  }}
                >
                  {[".75", "1", "1.25", "1.5", "2"].map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
              {!token && !readOnly && (
                <button
                  className={`btn small ${trim ? "active" : ""}`}
                  onClick={() => {
                    setTrim(!trim);
                    player.current?.pause();
                  }}
                >
                  <Scissors size={15} />
                  Trim video
                </button>
              )}
            </div>
          </div>
          {trim && (
            <section className="trim-panel">
              <div className="section-heading">
                <div>
                  <h3>Keep the good part.</h3>
                  <p className="small muted">
                    Set your in and out points. Your original stays safe.
                  </p>
                </div>
                <Scissors size={20} />
              </div>
              <FrameStrip
                src={mediaURL(clip)}
                duration={clip.duration}
                start={start}
                end={end}
                poster={clip.thumbnail}
                onSeek={seek}
              />
              <div className="trim-sliders">
                <label>
                  In{" "}
                  <input
                    aria-label="Trim start"
                    type="range"
                    min={0}
                    max={Math.max(0, end - 0.1)}
                    step=".1"
                    value={start}
                    onChange={(e) => {
                      setStart(+e.target.value);
                      seek(+e.target.value);
                    }}
                  />
                </label>
                <label>
                  Out{" "}
                  <input
                    aria-label="Trim end"
                    type="range"
                    min={start + 0.1}
                    max={clip.duration}
                    step=".1"
                    value={end}
                    onChange={(e) => {
                      setEnd(+e.target.value);
                      seek(+e.target.value);
                    }}
                  />
                </label>
              </div>
              <div className="trim-controls">
                <label>
                  Start (seconds)
                  <input
                    aria-label="Start seconds"
                    type="number"
                    min={0}
                    max={end - 0.1}
                    step=".1"
                    value={Math.round(start * 10) / 10}
                    onChange={(e) =>
                      setStart(
                        Math.max(
                          0,
                          Math.min(Number(e.target.value), end - 0.1),
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  End (seconds)
                  <input
                    aria-label="End seconds"
                    type="number"
                    min={start + 0.1}
                    max={clip.duration}
                    step=".1"
                    value={Math.round(end * 10) / 10}
                    onChange={(e) =>
                      setEnd(
                        Math.min(
                          clip.duration,
                          Math.max(+e.target.value, start + 0.1),
                        ),
                      )
                    }
                  />
                </label>
                <span className="muted small">
                  {clock(end - start)} selected
                </span>
                <button
                  className="btn primary"
                  disabled={busy || end <= start}
                  onClick={() => void exportTrim()}
                >
                  {busy ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}{" "}
                  {busy ? "Rendering…" : "Save trimmed copy"}
                </button>
              </div>
            </section>
          )}
          {!token && !readOnly && (
            <StudioWorkbench
              clip={clip}
              onRendered={(v) => {
                update(v);
                setTitle(v.title);
              }}
              notify={notify}
              onSeek={seek}
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
          <div className="video-heading">
            {token || readOnly ? (
              <h1>{clip.title}</h1>
            ) : (
              <input
                className="editable-title"
                aria-label="Video title"
                value={title}
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => {
                  if (title !== clip.title) void mutate({ title });
                }}
              />
            )}
            <div className="clip-meta">
              <span className="avatar owner">S</span>
              <strong>{token ? "Shared with you" : "Your recording"}</strong>
              <span>·</span>
              <span>
                {new Date(clip.created).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </span>
              <span>·</span>
              <span>{bytes(clip.size)}</span>
              {!token && !readOnly && (
                <>
                  <span>·</span>
                  <span>
                    <Eye size={14} />
                    {clip.views} views
                  </span>
                </>
              )}
            </div>
          </div>
          {token ? (
            <div className="reaction-bar">
              <span className="muted small">Send a little appreciation</span>
              {["❤️", "👏", "💡", "🎉"].map((emoji) => (
                <button key={emoji} onClick={() => void react(emoji)}>
                  {emoji}
                  <span>
                    {clip.reactions.find((r) => r.emoji === emoji)?.count || ""}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="organize-bar">
              <button
                className="text-button"
                onClick={() => void mutate({ starred: !clip.starred })}
              >
                <Star size={16} fill={clip.starred ? "currentColor" : "none"} />
                {clip.starred ? "Starred" : "Add to starred"}
              </button>
              <label>
                <Folder size={16} />
                <input
                  aria-label="Collection"
                  placeholder="Add to a collection"
                  defaultValue={clip.folder}
                  maxLength={80}
                  onBlur={(e) => {
                    if (e.target.value !== clip.folder)
                      void mutate({ folder: e.target.value });
                  }}
                />
              </label>
              <button
                className="text-button danger"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={16} />
                Delete
              </button>
            </div>
          )}
          {token && !!clip.transcript?.length && (
            <details className="transcript-public">
              <summary>Read the transcript</summary>
              <div>
                {clip.transcript.map((word, i) => (
                  <button
                    key={i}
                    onClick={() => seek(word.start)}
                    title={clock(word.start)}
                  >
                    {word.text}
                  </button>
                ))}
              </div>
            </details>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </main>
        <aside className="review-sidebar">
          <div className="review-tabs">
            <button
              className={tab === "activity" ? "active" : ""}
              onClick={() => setTab("activity")}
            >
              <MessageSquare size={16} />
              Feedback <span>{clip.comments.length}</span>
            </button>
            <button
              className={tab === "notes" ? "active" : ""}
              onClick={() => setTab("notes")}
            >
              <FileText size={16} />
              Notes
            </button>
            {!token && !readOnly && (
              <button
                className={tab === "analytics" ? "active" : ""}
                onClick={() => setTab("analytics")}
              >
                <Eye size={16} />
                Insights
              </button>
            )}
          </div>
          {tab === "activity" ? (
            <>
              <div className="comments">
                {clip.comments.length === 0 ? (
                  <div className="comment-empty">
                    <div className="empty-icon">
                      <MessageSquare size={25} strokeWidth={1.3} />
                    </div>
                    <h3>Start a conversation.</h3>
                    <p>
                      Good feedback has context.
                      <br />
                      Comments are linked to a moment.
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
                          onClick={() => seek(c.time)}
                        >
                          {clock(c.time)}
                        </button>
                        <p>{c.body}</p>
                        <div className="comment-actions">
                          <button
                            className="text-button small"
                            onClick={() => setReplyTo(c.id)}
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
                          {c.resolved && <span>Resolved</span>}
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
                  <input
                    aria-label="Your name"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={60}
                  />
                  <textarea
                    aria-label="Comment"
                    placeholder="Your feedback… Mention a teammate with @name or @email."
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    required
                    maxLength={2000}
                  />
                  <button
                    className="btn primary"
                    disabled={messageBusy || !name.trim() || !comment.trim()}
                  >
                    <Send size={15} />
                    {messageBusy ? "Sending…" : "Post comment"}
                  </button>
                </form>
              )}
              {readOnly && clip.token && (
                <a className="btn" href={`/s/${clip.token}`}>
                  Open review to leave feedback
                </a>
              )}
            </>
          ) : (
            <div className="notes">
              {tab === "analytics" ? (
                <AnalyticsPanel id={clip.id} />
              ) : (
                <>
                  {clip.outline?.summary && (
                    <>
                      <h3>In a few words.</h3>
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
                  <span className="eyebrow">A LITTLE MORE CONTEXT</span>
                  <h3>The useful details.</h3>
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
                      />
                      <button
                        className="btn primary"
                        disabled={notes === clip.description}
                        onClick={() => void mutate({ description: notes })}
                      >
                        <Check size={16} />
                        Save notes
                      </button>
                      <p className="muted small">
                        Notes are included on your shared watch page.
                      </p>
                    </>
                  )}
                </>
              )}{" "}
            </div>
          )}
          <div className="review-footer">
            <span className="wordmark mini">◒ relay</span>
            <span>Less meeting. More meaning.</span>
          </div>
        </aside>
      </div>
      {sharing && (
        <div className="dialog-backdrop" onClick={() => setSharing(false)}>
          <section
            className="dialog share-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Share your video"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="eyebrow">PASS IT ON</div>
            <h2>One link. All the context.</h2>
            <p className="muted">
              Choose who can watch and how they can respond.
            </p>
            <label className="share-link">
              <Link size={18} />
              <input
                aria-label="Share link"
                readOnly
                value={`${location.origin}/s/${clip.token}`}
                onFocus={(e) => e.target.select()}
              />
              <button
                className="icon-button"
                aria-label="Copy link"
                onClick={() => void copy()}
              >
                <Copy size={18} />
              </button>
            </label>
            <ShareSettings
              clip={clip}
              onChange={update}
              notify={notify}
              time={time}
            />
            <div className="dialog-footer">
              <button
                className="text-button danger"
                onClick={async () => {
                  try {
                    await api(`/api/videos/${clip.id}/share`, {
                      method: "DELETE",
                    });
                    update({ ...clip, token: null });
                    setSharing(false);
                    notify("Share link revoked");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <Unlink size={15} />
                Revoke link
              </button>
              <button className="btn primary" onClick={() => setSharing(false)}>
                Done
                <Check size={16} />
              </button>
            </div>
          </section>
        </div>
      )}
      {confirmDelete && (
        <div className="dialog-backdrop">
          <section
            className="dialog small-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Delete video"
          >
            <h2>Delete this video?</h2>
            <p className="muted">
              The recording, feedback and share link will be permanently
              deleted.
            </p>
            <div className="dialog-footer">
              <button className="btn" onClick={() => setConfirmDelete(false)}>
                Keep video
              </button>
              <button
                className="btn destructive"
                onClick={async () => {
                  try {
                    await api(`/api/videos/${clip.id}`, { method: "DELETE" });
                    onDelete();
                  } catch (e) {
                    setError((e as Error).message);
                    setConfirmDelete(false);
                  }
                }}
              >
                Delete video
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
