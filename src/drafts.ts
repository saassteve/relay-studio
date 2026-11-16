import { api, type Clip, type Project, type Job } from "./types";
export type TrackRole = "screen" | "camera" | "microphone" | "system";
export interface Draft {
  id: string;
  title: string;
  created: string;
  status:
    "recording" | "review" | "queued" | "processing" | "complete" | "discarded";
  duration: number;
  meta: {
    roles: TrackRole[];
    layout?: Project["layout"];
    excluded?: { start: number; end: number }[];
    pointers?: { time: number; x: number; y: number }[];
    autoZoom?: boolean;
  };
  jobId?: string;
  videoId?: string;
  error?: string;
  // Discarded here, but the server has not confirmed deleting its copy yet.
  discardPending?: boolean;
}
interface Part {
  key: string;
  recordingId: string;
  role: TrackRole;
  seq: number;
  mime: string;
  // Dropped once the server has the chunk, to free space on this device.
  blob?: Blob;
  end: number;
  uploaded: boolean;
}
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("relay-recordings", 1);
    request.onupgradeneeded = () => {
      const d = request.result;
      d.createObjectStore("drafts", { keyPath: "id" });
      const p = d.createObjectStore("parts", { keyPath: "key" });
      p.createIndex("recordingId", "recordingId");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function store<T>(
  name: "drafts" | "parts",
  mode: IDBTransactionMode,
  action: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(name, mode),
      request = action(tx.objectStore(name));
    let result: T;
    request.onsuccess = () => (result = request.result);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Local storage is unavailable."));
  });
}
const changed = () => dispatchEvent(new CustomEvent("relay:drafts"));
export const listDrafts = () =>
  store<Draft[]>("drafts", "readonly", (s) => s.getAll());
export const getDraft = (id: string) =>
  store<Draft | undefined>("drafts", "readonly", (s) => s.get(id));
// Reads and writes in one transaction, so two writers can never overwrite each
// other with a stale copy. Pass a function to build the change from the stored draft.
export async function updateDraft(
  id: string,
  patch: Partial<Draft> | ((draft: Draft) => Partial<Draft>),
) {
  const d = await db();
  const next = await new Promise<Draft>((resolve, reject) => {
    const tx = d.transaction("drafts", "readwrite"),
      drafts = tx.objectStore("drafts"),
      read = drafts.get(id);
    let result: Draft | undefined;
    read.onsuccess = () => {
      const current = read.result as Draft | undefined;
      if (!current) return;
      result = {
        ...current,
        ...(typeof patch === "function" ? patch(current) : patch),
      };
      drafts.put(result);
    };
    tx.oncomplete = () =>
      result
        ? resolve(result)
        : reject(new Error("This local recording was not found."));
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Local storage is unavailable."));
  });
  changed();
  return next;
}
export async function createDraft(meta: Draft["meta"]) {
  void navigator.storage?.persist?.();
  const draft: Draft = {
    id: crypto.randomUUID(),
    title: `Recording · ${new Date().toLocaleDateString()}`,
    created: new Date().toISOString(),
    status: "recording",
    duration: 0,
    meta,
  };
  await store("drafts", "readwrite", (s) => s.put(draft));
  changed();
  void syncDraft(draft.id);
  return draft;
}
export async function savePart(
  id: string,
  role: TrackRole,
  seq: number,
  blob: Blob,
  end: number,
) {
  const part: Part = {
    key: `${id}:${role}:${seq}`,
    recordingId: id,
    role,
    seq,
    blob,
    mime: blob.type,
    end,
    uploaded: false,
  };
  await store("parts", "readwrite", (s) => s.put(part));
  await updateDraft(id, { duration: end });
  void syncDraft(id);
}
const parts = (id: string) =>
  store<Part[]>("parts", "readonly", (s) => s.index("recordingId").getAll(id));
const running = new Map<string, Promise<void>>();
export function syncDraft(id: string): Promise<void> {
  if (running.has(id)) return running.get(id)!;
  const task = (async () => {
    try {
      let draft = await getDraft(id);
      if (!draft || ["complete", "discarded"].includes(draft.status)) return;
      await api("/api/recordings", {
        method: "POST",
        body: JSON.stringify({
          id: draft.id,
          title: draft.title,
          meta: draft.meta,
        }),
      });
      const pending = (await parts(id))
        .filter((p) => !p.uploaded && p.blob)
        .sort((a, b) => a.seq - b.seq);
      for (const part of pending) {
        const response = await fetch(
          `/api/recordings/${id}/parts/${part.role}/${part.seq}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "X-Track-Mime": part.mime,
              "X-Part-End": String(part.end),
            },
            body: part.blob,
          },
        );
        if (!response.ok) {
          const b = await response.json().catch(() => ({}));
          throw new Error(b.error || "A recording chunk could not be saved.");
        }
        // Discarded while this chunk was uploading: don't write it back.
        const current = await getDraft(id);
        if (!current || current.status === "discarded") return;
        // The server has this chunk on disk now and nothing reads the local copy
        // again, so only the record is kept. Long takes don't fill this device.
        await store("parts", "readwrite", (s) =>
          s.put({ ...part, blob: undefined, uploaded: true }),
        );
      }
      draft = (await getDraft(id))!;
      if (["queued", "processing"].includes(draft.status)) {
        // A capture may have flushed its final chunk while this upload was running.
        // Leave the draft queued until every durable local part has reached the server.
        if ((await parts(id)).some((p) => !p.uploaded)) return;
        if (!draft.jobId) {
          const job = await api<Job>(`/api/recordings/${id}/finish`, {
            method: "POST",
            body: JSON.stringify({
              duration: draft.duration,
              title: draft.title,
              meta: draft.meta,
            }),
          });
          if (job.status === "complete" && job.result?.videoId) {
            await finishLocal(id, job.result.videoId);
            return;
          }
          draft = await updateDraft(id, {
            status: "processing",
            jobId: job.id,
            error: undefined,
          });
        }
        if (draft.jobId) {
          const job = await api<Job>(`/api/jobs/${draft.jobId}`);
          if (job.status === "complete" && job.result?.videoId)
            await finishLocal(id, job.result.videoId);
          else if (job.status === "failed")
            throw new Error(
              job.error || "The recording could not be processed.",
            );
        }
      }
      if (draft.error) await updateDraft(id, { error: undefined });
    } catch (e) {
      await updateDraft(id, { error: (e as Error).message }).catch(() => {});
    }
  })().finally(() => running.delete(id));
  running.set(id, task);
  return task;
}
async function finishLocal(id: string, videoId: string) {
  await updateDraft(id, { status: "complete", videoId, error: undefined });
  for (const p of await parts(id))
    await store("parts", "readwrite", (s) => s.delete(p.key));
  changed();
}
export async function queueDraft(
  id: string,
  title: string,
  duration: number,
  meta?: Draft["meta"],
) {
  const current = await getDraft(id);
  if (current?.jobId) {
    const job = await api<Job>(`/api/jobs/${current.jobId}`);
    if (job.status === "failed") await updateDraft(id, { jobId: undefined });
  }
  await updateDraft(id, {
    status: "queued",
    title,
    duration,
    meta: meta || current!.meta,
    error: undefined,
  });
  await syncDraft(id);
  await syncDraft(id);
}
export async function waitForDraft(
  id: string,
  onProgress?: (s: string) => void,
): Promise<Clip> {
  const started = Date.now();
  while (Date.now() - started < 1800000) {
    await syncDraft(id);
    const draft = await getDraft(id);
    if (draft?.videoId) return api<Clip>(`/api/videos/${draft.videoId}`);
    if (draft?.error && !draft.jobId && navigator.onLine)
      throw new Error(draft.error);
    if (draft?.error && !navigator.onLine)
      throw new Error(
        "Saved on this device. It will upload when you reconnect.",
      );
    if (draft?.jobId) {
      const job = await api<Job>(`/api/jobs/${draft.jobId}`);
      onProgress?.(`${Math.round(job.progress || 0)}%`);
      if (job.status === "failed")
        throw new Error(
          job.error || "Processing failed. Your source tracks are safe.",
        );
    }
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error("Your recording is still processing in the background.");
}
export async function discardDraft(id: string) {
  const draft = await getDraft(id);
  if (draft?.status === "processing" && !draft.error) {
    // Still allow clearing out a recording whose processing has failed.
    const job = draft.jobId
      ? await api<Job>(`/api/jobs/${draft.jobId}`).catch(() => null)
      : null;
    if (job && job.status !== "failed")
      throw new Error("Wait for this recording to finish processing.");
  }
  await updateDraft(id, { status: "discarded", discardPending: true });
  for (const part of await parts(id))
    await store("parts", "readwrite", (s) => s.delete(part.key));
  void discardRemote(id);
  changed();
}
// Deletes the server's copy of a discarded recording. If the server can't be
// reached, the draft stays marked and sync tries again later.
const discarding = new Map<string, number>();
async function discardRemote(id: string) {
  if (Date.now() - (discarding.get(id) || 0) < 15000) return;
  discarding.set(id, Date.now());
  // Let an upload that is under way notice the discard first, so it can't
  // create the server's copy just after this has asked to delete it.
  await running.get(id);
  try {
    await api(`/api/recordings/${id}`, { method: "DELETE" });
  } catch (e) {
    // Never reached the server in the first place: nothing left to delete.
    if ((e as { status?: number }).status !== 404) return;
  }
  discarding.delete(id);
  await updateDraft(id, { discardPending: false }).catch(() => {});
}
export function startDraftSync(onComplete: () => void) {
  let previous: Set<string> | undefined;
  let stopped = false;
  const tick = async () => {
    const drafts = await listDrafts();
    previous ??= new Set(
      drafts.filter((d) => d.status === "complete").map((d) => d.id),
    );
    for (const draft of drafts) {
      if (draft.status === "complete" && !previous.has(draft.id)) {
        previous.add(draft.id);
        onComplete();
      }
      if (["queued", "processing", "recording"].includes(draft.status))
        void syncDraft(draft.id);
      if (draft.status === "discarded" && draft.discardPending)
        void discardRemote(draft.id);
    }
  };
  const online = () => void tick();
  addEventListener("online", online);
  void tick();
  const timer = setInterval(() => {
    if (!stopped) void tick();
  }, 2500);
  return () => {
    stopped = true;
    clearInterval(timer);
    removeEventListener("online", online);
  };
}
export async function awaitJob(
  job: Job,
  onProgress?: (j: Job) => void,
): Promise<Job> {
  let current = job;
  while (["queued", "running"].includes(current.status)) {
    onProgress?.(current);
    await new Promise((r) => setTimeout(r, 600));
    current = await api<Job>(`/api/jobs/${job.id}`);
  }
  if (current.status !== "complete")
    throw new Error(current.error || "Processing failed.");
  onProgress?.(current);
  return current;
}
