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
      { id: string; message: string; seen: number; video_id: string }[]
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
      for (const d of items)
        if (d.status === "recording")
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
  return (
    <>
      <button
        className="activity-button icon-button"
        aria-label="Recording recovery and notifications"
        onClick={() => setOpen(true)}
      >
        <Bell size={18} />
        {pending + unseen > 0 && <b>{pending + unseen}</b>}
      </button>
      {open && (
        <div className="dialog-backdrop" onClick={() => setOpen(false)}>
          <section
            className="dialog activity-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Recording recovery and notifications"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="dialog-close icon-button"
              aria-label="Close activity"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <div className="eyebrow">NOTHING LOST. NOTHING MISSED.</div>
            <h2>Your studio activity.</h2>
            <h3 className="studio-section-title">Recording recovery</h3>
            {!pending && (
              <p className="muted small">
                All recordings are saved. New sessions checkpoint every second.
              </p>
            )}
            {drafts.map((d) => (
              <article className="activity-item" key={d.id}>
                <CloudUpload size={20} />
                <div>
                  <strong>{d.title}</strong>
                  <small>
                    {clock(d.duration)} · {d.status}
                    {d.error ? ` · ${d.error}` : ""}
                  </small>
                </div>
                <button
                  className="btn small"
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
                {d.status !== "processing" && (
                  <button
                    className="icon-button danger"
                    aria-label={`Discard ${d.title}`}
                    onClick={async () => {
                      if (
                        confirm(
                          "Delete this recoverable recording and its local source chunks?",
                        )
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
                    <small>{clock(r.duration)} · Server checkpoint</small>
                  </div>
                  <button
                    className="btn small"
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
            <h3 className="studio-section-title">Processing</h3>
            {jobs.slice(0, 6).map((j) => (
              <article className="activity-item" key={j.id}>
                <span className={j.status === "running" ? "spin" : ""}>
                  {j.status === "complete" ? (
                    <Check size={18} />
                  ) : (
                    <RefreshCw size={18} />
                  )}
                </span>
                <div>
                  <strong>{j.type}</strong>
                  <small>
                    {j.status} · {Math.round(j.progress)}%
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
            <div className="section-heading studio-section-title">
              <h3>Notifications</h3>
              <button
                className="text-button small"
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
                {n.message}
              </button>
            ))}
            {!notifications.length && (
              <p className="muted small">
                Feedback and processing updates appear here.
              </p>
            )}
            {error && <div className="error">{error}</div>}
          </section>
        </div>
      )}
    </>
  );
}
