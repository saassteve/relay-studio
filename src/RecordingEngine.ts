import {
  createDraft,
  savePart,
  updateDraft,
  getDraft,
  type Draft,
  type TrackRole,
} from "./drafts";
import type { CaptureSession } from "./media";
export class RecordingEngine {
  capture: CaptureSession;
  id = "";
  recorders: MediaRecorder[] = [];
  writes: Promise<unknown>[] = [];
  elapsed = 0;
  started = 0;
  paused = false;
  stopped = false;
  excluded: { start: number; end: number }[] = [];
  pointers: { time: number; x: number; y: number }[] = [];
  onFailure: (message: string) => void = () => {};
  stopPromise?: Promise<Draft | undefined>;
  release: () => void = () => {};
  constructor(capture: CaptureSession) {
    this.capture = capture;
  }
  seconds() {
    return (
      (this.elapsed + (this.started ? performance.now() - this.started : 0)) /
      1000
    );
  }
  async start(layout?: Draft["meta"]["layout"]) {
    const roles = Object.keys(this.capture.tracks) as TrackRole[];
    const draft = await createDraft({ roles, layout, excluded: [] });
    this.id = draft.id;
    // Held for the life of the take so other tabs know it is still recording.
    void navigator.locks
      ?.request(
        `relay-rec-${draft.id}`,
        () => new Promise<void>((r) => (this.release = r)),
      )
      .catch(() => {});
    for (const role of roles) {
      const stream = this.capture.tracks[role]!;
      const audioOnly = !stream.getVideoTracks().length;
      const types = audioOnly
        ? ["audio/webm;codecs=opus", "audio/mp4"]
        : ["video/webm;codecs=vp8", "video/webm;codecs=vp9", "video/mp4"];
      const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        ...(audioOnly
          ? { audioBitsPerSecond: 128000 }
          : { videoBitsPerSecond: 6000000 }),
      });
      let seq = 0;
      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          const write = savePart(
            this.id,
            role,
            seq++,
            event.data,
            this.seconds(),
          ).catch((error) => {
            this.onFailure(`Local recording storage failed: ${error.message}`);
            this.pause();
            throw error;
          });
          this.writes.push(write);
          void write.catch(() => {});
        }
      };
      recorder.onerror = () => {
        this.onFailure(
          `The ${role} track was interrupted. Saved chunks can be recovered.`,
        );
        void this.stop();
      };
      this.recorders.push(recorder);
    }
    this.started = performance.now();
    for (const r of this.recorders) r.start(1000);
    for (const stream of Object.values(this.capture.tracks))
      for (const track of stream!.getTracks())
        track.addEventListener(
          "ended",
          () => {
            void this.stop();
          },
          { once: true },
        );
    return draft;
  }
  pause() {
    if (this.paused || this.stopped) return;
    this.elapsed += performance.now() - this.started;
    this.started = 0;
    for (const r of this.recorders) if (r.state === "recording") r.pause();
    this.paused = true;
  }
  resume() {
    if (!this.paused || this.stopped) return;
    this.started = performance.now();
    for (const r of this.recorders) if (r.state === "paused") r.resume();
    this.paused = false;
  }
  retake(seconds = 10) {
    const end = this.seconds(),
      start = Math.max(0, end - seconds);
    if (end - start < 0.1) return;
    this.excluded.push({ start, end });
    void getDraft(this.id).then(
      (d) =>
        d &&
        updateDraft(this.id, {
          meta: { ...d.meta, excluded: this.excluded, pointers: this.pointers },
        }),
    );
  }
  point(point: { x: number; y: number }) {
    if (this.stopped || this.paused || this.pointers.length >= 20000) return;
    const time = this.seconds();
    if (!this.pointers.length || time - this.pointers.at(-1)!.time >= 0.14)
      this.pointers.push({ ...point, time });
  }
  stop(): Promise<Draft | undefined> {
    return (this.stopPromise ??= this.finish());
  }
  private async finish() {
    this.stopped = true;
    const duration = this.seconds();
    this.elapsed = duration * 1000;
    this.started = 0;
    await Promise.all(
      this.recorders.map(
        (r) =>
          new Promise<void>((resolve) => {
            if (r.state === "inactive") return resolve();
            r.addEventListener("stop", () => resolve(), { once: true });
            r.stop();
          }),
      ),
    );
    const writes = await Promise.allSettled(this.writes);
    this.release();
    this.capture.cleanup();
    const d = (await getDraft(this.id))!;
    return updateDraft(this.id, {
      status: "review",
      duration,
      meta: { ...d.meta, excluded: this.excluded, pointers: this.pointers },
      ...(writes.some((r) => r.status === "rejected")
        ? {
            error:
              "Some chunks could not be stored. Recover the saved portion from Activity.",
          }
        : {}),
    });
  }
}
