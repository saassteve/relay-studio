import { useEffect, useState } from "react";
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
  syncDraft,
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
  processing: "Processing",
  recorded: "Not uploaded yet",
  uploading: "Uploading",
};
const plain = (state: string) => STATES[state] || state;
export function RecoveryCenter({
  onOpen,
  notify,
}: {
  onOpen: (v: Clip) => void;
  notify: (message: string) => void;
}) {
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
  const load = async () => {
    const local = await listDrafts();
    setDrafts(
      local.filter((d) => !["complete", "discarded"].includes(d.status)),
    );
    void api<typeof remote>("/api/recordings")
      .then(setRemote)
      .catch(() => {});
    void api<Job[]>("/api/jobs")
      .then(setJobs)
      .catch(() => {});
    void api<typeof notifications>("/api/notifications")
      .then(setNotifications)
      .catch(() => {});
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
      if (alive) void load();
    });
    const changed = () => {
      if (alive) void load();
    };
    addEventListener("relay:drafts", changed);
    const timer = setInterval(changed, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
      removeEventListener("relay:drafts", changed);
    };
  }, []);
  const recover = async (d: Draft) => {
    setBusy(d.id);
    setError("");
    try {
      await queueDraft(d.id, d.title, d.duration, d.meta);
      onOpen(await waitForDraft(d.id));
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      void load();
    }
  };
  const unseen = notifications.filter((n) => !n.seen).length,
    pending =
      drafts.length +
      remote.filter((r) => !drafts.some((d) => d.id === r.id)).length;
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
                      await discardDraft(d.id);
                      void load();
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </article>
          ))}
          {remote
            .filter((r) => !drafts.some((d) => d.id === r.id))
            .map((r) => (
              <article className="activity-item" key={r.id}>
                <Clapperboard size={20} />
                <div>
                  <strong>{r.title}</strong>
                  <small>{clock(r.duration)} · Saved, not finished</small>
                </div>
                <button
                  className="btn small"
                  aria-label={`Recover ${r.title}`}
                  disabled={!!busy}
                  onClick={async () => {
                    setBusy(r.id);
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
                      setError((e as Error).message);
                    } finally {
                      setBusy("");
                      void load();
                    }
                  }}
                >
                  Recover
                </button>
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
                    await api(`/api/jobs/${j.id}/retry`, { method: "POST" });
                    void load();
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
                await api("/api/notifications/all/read", { method: "POST" });
                void load();
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
                await api(`/api/notifications/${n.id}/read`, {
                  method: "POST",
                });
                if (n.video_id)
                  onOpen(await api<Clip>(`/api/videos/${n.video_id}`));
                setOpen(false);
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
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
