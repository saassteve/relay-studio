import { useEffect, useRef, useState } from "react";
import {
  CloudUpload,
  RefreshCw,
  Trash2,
  LoaderCircle,
  Check,
  Bell,
  Clapperboard,
} from "lucide-react";
import {
  listDrafts,
  queueDraft,
  waitForDraft,
  discardDraft,
  updateDraft,
  type Draft,
  awaitJob,
} from "./drafts";
import { api, clock, type Clip, type Job } from "./types";
import { Modal, confirmDialog } from "./Modal";

const JOBS: Record<string, string> = {
  "finish-recording": "Preparing a recording",
  stream: "Preparing smooth playback",
  render: "Updating a video",
  transcribe: "Creating a transcript",
  summarize: "Writing a summary",
  assist: "Writing suggestions",
  "prepare-ai": "Getting transcription ready",
};
const STATES: Record<string, string> = {
  queued: "Waiting",
  running: "Working",
  complete: "Done",
  failed: "Didn’t finish",
  recording: "Recording now",
  review: "Not uploaded yet",
  processing: "Processing",
  interrupted: "Saved, not finished",
};
const plain = (state: string) => STATES[state] || state;
// What went wrong, in words that say what to do about it.
const reason = (e: unknown) =>
  e instanceof TypeError
    ? "Relay couldn’t reach the server. Check your connection and try again."
    : (e as Error).message || "That didn’t work. Try again.";
export function RecoveryCenter({ onOpen }: { onOpen: (v: Clip) => void }) {
  const [drafts, setDrafts] = useState<Draft[]>([]),
    [remote, setRemote] = useState<
      {
        id: string;
        title: string;
        duration: number;
        status: string;
        job_id?: string;
      }[]
    >([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [notifications, setNotifications] = useState<
      {
        id: string;
        message: string;
        seen: number;
        video_id: string;
        created?: string;
      }[]
    >([]),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  // Recordings discarded here whose server copy is still waiting to be deleted.
  const [discarding, setDiscarding] = useState<string[]>([]);
  const shown = useRef(open);
  shown.current = open;
  // The count on the bell needs recordings and notifications; the list of jobs
  // is only read while Activity is open.
  const loadRemote = () => {
    void api<typeof remote>("/api/recordings")
      .then(setRemote)
      .catch(() => {});
    void api<typeof notifications>("/api/notifications")
      .then(setNotifications)
      .catch(() => {});
    if (shown.current)
      void api<Job[]>("/api/jobs")
        .then(setJobs)
        .catch(() => {});
  };
  // Which drafts exist and what state each is in, as last seen.
  const known = useRef("");
  const loadLocal = async () => {
    const local = await listDrafts();
    setDrafts(
      local.filter((d) => !["complete", "discarded"].includes(d.status)),
    );
    setDiscarding(local.filter((d) => d.discardPending).map((d) => d.id));
    // A draft that appears, finishes or is discarded changes the server's list
    // too. One that only grows as it records does not.
    const now = local
      .map((d) => `${d.id} ${d.status} ${d.discardPending ? "pending" : ""}`)
      .join();
    if (now !== known.current) {
      known.current = now;
      loadRemote();
    }
  };
  const load = () => {
    void loadLocal();
    loadRemote();
  };
  useEffect(() => {
    let alive = true;
    void listDrafts().then(async (items) => {
      // A take still being recorded in another tab or window holds a lock.
      const live = new Set(
        (await navigator.locks?.query().catch(() => null))?.held?.map(
          (l) => l.name,
        ) || [],
      );
      for (const d of items)
        if (d.status === "recording" && !live.has(`relay-rec-${d.id}`))
          await updateDraft(d.id, { status: "review" });
      if (alive) void loadLocal();
    });
    // Drafts change with every second recorded. Only the list kept on this
    // device is read again, and not more than twice a second.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const changed = () => {
      pending ??= setTimeout(() => {
        pending = undefined;
        if (alive) void loadLocal();
      }, 500);
    };
    addEventListener("relay:drafts", changed);
    return () => {
      alive = false;
      clearTimeout(pending);
      removeEventListener("relay:drafts", changed);
    };
  }, []);
  // The server is asked often while Activity is open, and only now and then
  // otherwise, to keep the count on the bell honest.
  useEffect(() => {
    loadRemote();
    const timer = setInterval(
      () => document.hidden || loadRemote(),
      open ? 5000 : 60000,
    );
    return () => clearInterval(timer);
  }, [open]);
  const recover = async (d: Draft) => {
    setBusy(d.id);
    setError("");
    try {
      await queueDraft(d.id, d.title, d.duration, d.meta);
      onOpen(await waitForDraft(d.id));
      setOpen(false);
    } catch (e) {
      setError(reason(e));
    } finally {
      setBusy("");
      load();
    }
  };
  // Saved on the server, with nothing on this device to match.
  const orphans = remote.filter(
    (r) => !drafts.some((d) => d.id === r.id) && !discarding.includes(r.id),
  );
  const unseen = notifications.filter((n) => !n.seen).length,
    pending = drafts.length + orphans.length;
  const active = jobs.filter((j) => j.status !== "complete");
  return (
    <>
      <button
        className="activity-button icon-button"
        aria-label={
          pending + unseen > 0
            ? `Activity, ${pending + unseen} new`
            : "Activity"
        }
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Bell size={18} />
        {pending + unseen > 0 && <b aria-hidden="true">{pending + unseen}</b>}
      </button>
      {open && (
        <Modal
          label="Activity"
          className="activity-dialog"
          onClose={() => setOpen(false)}
        >
          <h2>Activity</h2>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <h3 className="studio-section-title">Unfinished recordings</h3>
          {!pending && (
            <p className="muted small">
              Nothing to recover. Recordings are saved every second as you
              record, so a crash or closed tab won’t lose them.
            </p>
          )}
          {drafts.map((d) => (
            <article className="activity-item" key={d.id}>
              <CloudUpload size={20} />
              <div>
                <strong>{d.title}</strong>
                <small>
                  {clock(d.duration)} · {plain(d.status)}
                  {d.error ? ` · ${d.error}` : ""}
                </small>
              </div>
              <button
                className="btn small"
                aria-label={`Recover ${d.title}`}
                disabled={!!busy || d.status === "recording"}
                onClick={() => void recover(d)}
              >
                {busy === d.id ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}
                Recover
              </button>
              {(d.status !== "processing" || d.error) && (
                <button
                  className="icon-button danger"
                  aria-label={`Discard ${d.title}`}
                  onClick={async () => {
                    if (
                      await confirmDialog({
                        title: "Delete this recording?",
                        body: `“${d.title}” hasn’t been saved to your library. Deleting it can’t be undone.`,
                        confirm: "Delete recording",
                        destructive: true,
                      })
                    ) {
                      setError("");
                      await discardDraft(d.id).catch((e) =>
                        setError(reason(e)),
                      );
                      load();
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </article>
          ))}
          {orphans.map((r) => (
            <article className="activity-item" key={r.id}>
              <Clapperboard size={20} />
              <div>
                <strong>{r.title}</strong>
                <small>
                  {clock(r.duration)} ·{" "}
                  {STATES[r.status] ? plain(r.status) : "Saved, not finished"}
                </small>
              </div>
              {/* Still being recorded somewhere else: finishing it here would cut it short. */}
              {r.status !== "recording" && (
                <button
                  className="btn small"
                  aria-label={`Recover ${r.title}`}
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(r.id);
                    setError("");
                    try {
                      const j = await api<Job>(
                        `/api/recordings/${r.id}/finish`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            duration: r.duration,
                            title: r.title,
                          }),
                        },
                      );
                      const result = await awaitJob(j);
                      if (result.result?.videoId) {
                        onOpen(
                          await api<Clip>(
                            `/api/videos/${result.result.videoId}`,
                          ),
                        );
                        setOpen(false);
                      }
                    } catch (e) {
                      setError(reason(e));
                    } finally {
                      setBusy("");
                      load();
                    }
                  }}
                >
                  {busy === r.id && <LoaderCircle className="spin" size={14} />}
                  Recover
                </button>
              )}
              {r.status !== "processing" && (
                <button
                  className="icon-button danger"
                  aria-label={`Discard ${r.title}`}
                  disabled={!!busy}
                  onClick={async () => {
                    if (
                      !(await confirmDialog({
                        title: "Delete this recording?",
                        body:
                          r.status === "recording"
                            ? `“${r.title}” may still be recording on another device. Deleting it ends that recording and can’t be undone.`
                            : `“${r.title}” hasn’t been saved to your library. Deleting it can’t be undone.`,
                        confirm: "Delete recording",
                        destructive: true,
                      }))
                    )
                      return;
                    setError("");
                    try {
                      await api(`/api/recordings/${r.id}`, {
                        method: "DELETE",
                      });
                    } catch (e) {
                      setError(reason(e));
                    }
                    load();
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </article>
          ))}
          {active.length > 0 && (
            <h3 className="studio-section-title">In progress</h3>
          )}
          {active.slice(0, 6).map((j) => (
            <article className="activity-item" key={j.id}>
              <span className={j.status === "running" ? "spin" : ""}>
                {j.status === "complete" ? (
                  <Check size={18} />
                ) : (
                  <RefreshCw size={18} />
                )}
              </span>
              <div>
                <strong>{JOBS[j.type || ""] || j.type}</strong>
                <small>
                  {plain(j.status)}
                  {j.status === "running"
                    ? ` · ${Math.round(j.progress)}%`
                    : ""}
                  {j.error ? " · " + j.error : ""}
                </small>
              </div>
              {j.status === "failed" && (
                <button
                  className="btn small"
                  onClick={async () => {
                    setError("");
                    await api(`/api/jobs/${j.id}/retry`, {
                      method: "POST",
                    }).catch((e) => setError(reason(e)));
                    load();
                  }}
                >
                  Retry
                </button>
              )}
            </article>
          ))}
          <div className="section-heading activity-heading">
            <h3 className="studio-section-title">Notifications</h3>
            <button
              className="text-button small"
              hidden={!unseen}
              onClick={async () => {
                setError("");
                await api("/api/notifications/all/read", {
                  method: "POST",
                }).catch((e) => setError(reason(e)));
                load();
              }}
            >
              Mark all read
            </button>
          </div>
          {notifications.slice(0, 12).map((n) => (
            <button
              className={`notification-item ${n.seen ? "" : "unread"}`}
              key={n.id}
              onClick={async () => {
                setError("");
                try {
                  await api(`/api/notifications/${n.id}/read`, {
                    method: "POST",
                  });
                  if (n.video_id)
                    onOpen(await api<Clip>(`/api/videos/${n.video_id}`));
                  setOpen(false);
                } catch (e) {
                  setError(reason(e));
                  loadRemote();
                }
              }}
            >
              <span className="avatar" aria-hidden="true">
                {(n.message.trim()[0] || "•").toUpperCase()}
              </span>
              <span>
                {n.message}
                {n.created && (
                  <small>
                    {new Date(n.created).toLocaleString(undefined, {
                      day: "numeric",
                      month: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </small>
                )}
              </span>
              {!n.seen && (
                <i className="unread-dot">
                  <span className="sr-only">New</span>
                </i>
              )}
            </button>
          ))}
          {!notifications.length && (
            <p className="muted small">
              Comments and reactions on your videos appear here.
            </p>
          )}
        </Modal>
      )}
    </>
  );
}
