import {
  createDraft,
  savePart,
  updateDraft,
  type Draft,
  type TrackRole,
} from "./drafts";
import type { CaptureSession } from "./media";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RecordingEngine {
  capture: CaptureSession;
  id = "";
  recorders: MediaRecorder[] = [];
  // One chain of writes per track, so chunks are stored strictly in order.
  writes: Promise<void>[] = [];
  // The picture. The take cannot go on without it.
  main: TrackRole = "screen";
  // Where the stored picture ends, in seconds.
  storedEnd = 0;
  storageFailed = false;
  elapsed = 0;
  started = 0;
  paused = false;
  stopped = false;
  excluded: { start: number; end: number }[] = [];
  pointers: { time: number; x: number; y: number }[] = [];
  // The take had to stop early. The message says why.
  onFailure: (message: string) => void = () => {};
  // Something was lost, but the take carries on.
  onNotice: (message: string) => void = () => {};
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
    this.main = roles.includes("screen") ? "screen" : "camera";
    const draft = await createDraft({ roles, layout, excluded: [] });
    this.id = draft.id;
    // Held for the life of the take so other tabs know it is still recording.
    void navigator.locks
      ?.request(
        `relay-rec-${draft.id}`,
        () => new Promise<void>((r) => (this.release = r)),
      )
      .catch(() => {});
    roles.forEach((role, index) => {
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
      this.writes[index] = Promise.resolve();
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return;
        const blob = event.data,
          end = this.seconds();
        // A number is used up only once its chunk is safely stored, so a failed
        // write can never leave a gap that would make the whole take unusable.
        this.writes[index] = this.writes[index].then(async () => {
          for (let attempt = 0; !this.storageFailed; attempt++) {
            try {
              await savePart(this.id, role, seq, blob, end);
              seq += 1;
              if (role === this.main) this.storedEnd = end;
              return;
            } catch {
              if (attempt < 3) await wait(300 * 2 ** attempt);
              else this.storageFull();
            }
          }
        });
      };
      recorder.onerror = () => this.lost(role, true);
      this.recorders.push(recorder);
    });
    this.started = performance.now();
    for (const r of this.recorders) r.start(1000);
    for (const role of roles)
      for (const track of this.capture.tracks[role]!.getTracks())
        track.addEventListener("ended", () => this.lost(role), { once: true });
    return draft;
  }
  // A track ended or its recorder failed. Losing the picture ends the take;
  // losing anything else is reported and the take carries on.
  private lost(role: TrackRole, failed = false) {
    if (this.stopped) return;
    if (role !== this.main) {
      // Sound shared with the screen ends along with it. Wait a moment, so the
      // end of the take is not reported as a lost device.
      setTimeout(() => {
        if (!this.stopped)
          this.onNotice(
            `${role === "system" ? "Computer sound stopped" : `Your ${role} disconnected`}. The recording is still going without it.`,
          );
      }, 400);
      return;
    }
    // "Stop sharing" is a normal way to finish. Anything else gets an explanation.
    if (failed)
      this.onFailure(
        "The recording was interrupted. What you recorded so far is kept.",
      );
    else if (role === "camera")
      this.onFailure(
        "Your camera disconnected, so the recording stopped. What you recorded so far is kept.",
      );
    void this.stop();
  }
  private storageFull() {
    if (this.storageFailed) return;
    this.storageFailed = true;
    this.onFailure(
      "This device couldn’t save any more, so the recording stopped. Everything up to that point is kept. Free up some disk space before you record again.",
    );
    void this.stop();
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
    void updateDraft(this.id, (d) => ({
      meta: { ...d.meta, excluded: this.excluded, pointers: this.pointers },
    })).catch(() => {});
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
    let duration = this.seconds();
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
    await Promise.all(this.writes);
    this.release();
    this.capture.cleanup();
    // Storage ran out: the take ends where its stored footage does.
    if (this.storageFailed && this.storedEnd)
      duration = Math.min(duration, this.storedEnd);
    return updateDraft(this.id, (d) => ({
      status: "review",
      duration,
      meta: { ...d.meta, excluded: this.excluded, pointers: this.pointers },
    }));
  }
}
