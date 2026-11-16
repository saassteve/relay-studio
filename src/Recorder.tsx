import { useEffect, useRef, useState } from "react";
import {
  Monitor,
  Video,
  Mic,
  MicOff,
  Camera,
  Pause,
  Play,
  Square,
  ArrowUpRight,
  Check,
  LoaderCircle,
  RotateCcw,
  Crop,
} from "lucide-react";
import {
  acquireCapture,
  deviceMissing,
  openInput,
  type CaptureOptions,
  type CaptureSession,
} from "./media";
import { api, clock, type Clip, type Mode, type DesktopSource } from "./types";
import { RecordingEngine } from "./RecordingEngine";
import {
  queueDraft,
  waitForDraft,
  discardDraft,
  updateDraft,
  type Draft,
} from "./drafts";
import { cachedPreferences, pref, savePreferences } from "./prefs";
import { CameraLookPicker } from "./CameraLook";
import { confirmDialog, radio } from "./Modal";
import type { CameraLook } from "./cameraEffects";
import { isLocal } from "./local";

type Phase =
  "setup" | "preparing" | "recording" | "paused" | "review" | "saving";
type Region = CaptureOptions["region"];
const SOURCES = {
  screen: "Screen sharing",
  camera: "Your camera",
  microphone: "Your microphone",
  system: "Computer sound",
};
export function Recorder({
  onClose,
  onSaved,
  guard,
}: {
  onClose: () => void;
  // `linkFailed`: a share link was asked for but could not be made.
  onSaved: (c: Clip, copied?: boolean, linkFailed?: boolean) => void;
  guard?: React.RefObject<() => Promise<boolean>>;
}) {
  const saved = cachedPreferences();
  const canCaptureScreen =
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const [mode, setModeState] = useState<Mode>(
      canCaptureScreen ? saved.mode || "screen-camera" : "camera",
    ),
    [mic, setMic] = useState(true),
    [quality, setQualityState] = useState<number>(pref("quality")),
    [phase, setPhase] = useState<Phase>("setup"),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState(""),
    [screenBlocked, setScreenBlocked] = useState(false),
    [notice, setNotice] = useState(""),
    // Devices that dropped out while recording. The take carries on without them.
    [lost, setLost] = useState<string[]>([]),
    [micTest, setMicTest] = useState(""),
    [title, setTitle] = useState(""),
    [sources, setSources] = useState<DesktopSource[] | null>(null),
    [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [microphoneId, setMicrophoneIdState] = useState(saved.microphoneId || ""),
    [cameraId, setCameraIdState] = useState(saved.cameraId || ""),
    [systemAudio, setSystemAudioState] = useState<boolean>(pref("systemAudio")),
    [autoShare, setAutoShare] = useState(
      pref("afterRecording") === "copy-link",
    ),
    [count, setCount] = useState<number | null>(null),
    [look, setLookState] = useState<CameraLook>({
      filter: pref("cameraFilter"),
      background: pref("cameraBackground"),
    }),
    [autoZoom, setAutoZoomState] = useState<boolean>(pref("autoZoom")),
    [notes, setNotes] = useState(""),
    [meter, setMeter] = useState(0),
    [crop, setCrop] = useState(false),
    [progress, setProgress] = useState(""),
    [draft, setDraft] = useState<Draft | null>(null);
  // Remember recorder choices for next time.
  const setMode = (v: Mode) => {
      setModeState(v);
      void savePreferences({ mode: v });
    },
    setQuality = (v: number) => {
      setQualityState(v);
      if (v === 1280 || v === 1920 || v === 3840)
        void savePreferences({ quality: v });
    },
    setMicrophoneId = (v: string) => {
      setMicrophoneIdState(v);
      void savePreferences({ microphoneId: v });
    },
    setCameraId = (v: string) => {
      setCameraIdState(v);
      void savePreferences({ cameraId: v });
    },
    setLook = (v: CameraLook) => {
      setLookState(v);
      void savePreferences({
        cameraFilter: v.filter,
        cameraBackground: v.background,
      });
    },
    setAutoZoom = (v: boolean) => {
      setAutoZoomState(v);
      void savePreferences({ autoZoom: v });
    },
    setSystemAudio = (v: boolean) => {
      setSystemAudioState(v);
      void savePreferences({ systemAudio: v });
    };
  // The tab itself shows that a recording is running, so it is easy to find again.
  const ownTitle = useRef(document.title);
  useEffect(() => {
    if (phase !== "recording" && phase !== "paused") return;
    const before = ownTitle.current;
    document.title = `${phase === "paused" ? "Paused" : "● Recording"} ${clock(seconds)} · Relay`;
    return () => {
      document.title = before;
    };
  }, [phase, seconds]);
  // Reloading or closing the tab would end the take, so the browser asks first.
  // The Mac app has no such prompt: there it would only make the window refuse to close.
  useEffect(() => {
    if ((phase !== "recording" && phase !== "paused") || window.relayDesktop)
      return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [phase]);
  const countdownDone = useRef<((go: boolean) => void) | null>(null);
  const runCountdown = (seconds: number) =>
    new Promise<boolean>((resolve) => {
      let n = seconds;
      setCount(n);
      const timer = setInterval(() => {
        n -= 1;
        if (n <= 0) done(true);
        else setCount(n);
      }, 1000);
      const key = (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          done(false);
        }
      };
      const done = (go: boolean) => {
        clearInterval(timer);
        removeEventListener("keydown", key, true);
        countdownDone.current = null;
        setCount(null);
        resolve(go);
      };
      addEventListener("keydown", key, true);
      countdownDone.current = done;
    });
  // Closing while recording stops the take, so ask first.
  if (guard)
    guard.current = async () =>
      !["recording", "paused"].includes(phase) ||
      confirmDialog({
        title: "Stop recording and close?",
        body: "What you’ve recorded so far is kept. You can finish it from Activity.",
        confirm: "Stop and close",
        cancel: "Keep recording",
      });
  const preview = useRef<HTMLVideoElement>(null),
    engine = useRef<RecordingEngine | null>(null),
    capture = useRef<CaptureSession | null>(null),
    tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    mounted = useRef(true);
  useEffect(() => {
    const list = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then(setDevices)
        .catch(() => {});
    list();
    navigator.mediaDevices?.addEventListener?.("devicechange", list);
    return () => {
      navigator.mediaDevices?.removeEventListener?.("devicechange", list);
      mounted.current = false;
      clearInterval(tick.current);
      if (engine.current && !engine.current.stopped) void engine.current.stop();
      else capture.current?.cleanup();
      window.relayDesktop?.captureState?.({
        active: false,
        paused: false,
        seconds: 0,
        notes: "",
      });
    };
  }, []);
  // A remembered device that has gone (unplugged, or chosen in another browser)
  // is forgotten, so the lists always show what will really be used.
  useEffect(() => {
    if (deviceMissing(devices, "camera", cameraId)) setCameraId("");
    if (deviceMissing(devices, "microphone", microphoneId)) setMicrophoneId("");
  }, [devices]);
  const finishing = useRef(false),
    // Why the take ended early, if it did. Never cleared by finishing.
    failure = useRef("");
  const finish = async () => {
    if (finishing.current) return;
    finishing.current = true;
    try {
      setPhase("preparing");
      // Read the on-screen bubble position before the native surfaces close.
      const camera = await window.relayDesktop
        ?.cameraLayout?.()
        .catch(() => null);
      let d = await engine.current?.stop();
      if (d)
        d = await updateDraft(d.id, {
          meta: {
            ...d.meta,
            autoZoom: pref("autoZoom") && Boolean(d.meta.pointers?.length),
            ...(camera
              ? {
                  layout: {
                    ...(d.meta.layout || {}),
                    camera,
                  } as Draft["meta"]["layout"],
                }
              : {}),
          },
        });
      clearInterval(tick.current);
      window.relayDesktop?.captureState?.({
        active: false,
        paused: false,
        seconds: 0,
        notes: "",
      });
      if (d && mounted.current) {
        setDraft(d);
        setError(failure.current || d.error || "");
        setSeconds(d.duration);
        setPhase("review");
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase("review");
    }
  };
  const pause = () => {
    const e = engine.current;
    if (!e) return;
    if (e.paused) {
      e.resume();
      setPhase("recording");
    } else {
      e.pause();
      setPhase("paused");
    }
  };
  useEffect(
    () =>
      window.relayDesktop?.onControl?.((action) => {
        if (action === "stop") void finish();
        else if (action === "cancel") void cancel();
        else if (action === "pause") pause();
        else if (action === "retake") {
          engine.current?.retake();
          setNotice("The last 10 seconds will be cut. Keep recording.");
        }
      }),
    [],
  );
  const cancel = async () => {
    clearInterval(tick.current);
    const d = await engine.current?.stop().catch(() => undefined);
    window.relayDesktop?.captureState?.({
      active: false,
      paused: false,
      seconds: 0,
      notes: "",
    });
    if (d) await discardDraft(d.id).catch(() => {});
    onClose();
  };
  useEffect(
    () =>
      window.relayDesktop?.onPointer?.((point) => engine.current?.point(point)),
    [],
  );
  const start = async (selectedRegion?: Region) => {
    setError("");
    setNotice("");
    setLost([]);
    failure.current = "";
    setPhase("preparing");
    try {
      let camera = cameraId;
      const session = await acquireCapture(mode, mic, quality, {
        microphoneId,
        cameraId,
        systemAudio,
        region: selectedRegion,
        look,
        onMissingDevice: (device) => {
          if (device === "camera") {
            camera = "";
            setCameraId("");
          } else setMicrophoneId("");
          setNotice(
            `Your usual ${device} wasn’t found, so the default one is being used.`,
          );
        },
      });
      capture.current = session;
      if (!mounted.current) {
        session.cleanup();
        return;
      }
      if (preview.current) {
        preview.current.srcObject = session.stream;
        await preview.current.play();
      }
      const seconds = pref("countdown");
      const go =
        window.relayDesktop?.prepareRecording && mode !== "camera"
          ? !(
              await window.relayDesktop.prepareRecording({
                screen: true,
                hideWindow: pref("hideWindow"),
                countdown: seconds,
                bubble: mode === "screen-camera" && pref("bubble"),
                bubbleSize: pref("bubbleSize"),
                cameraId: camera,
                filter: look.filter,
                background: look.background,
              })
            ).cancelled
          : seconds
            ? await runCountdown(seconds)
            : true;
      if (!go || !mounted.current) {
        session.cleanup();
        capture.current = null;
        if (mounted.current) setPhase("setup");
        return;
      }
      // "Stop sharing" during the countdown leaves nothing to record.
      const ended = (
        Object.keys(session.tracks) as (keyof typeof SOURCES)[]
      ).filter((role) =>
        session.tracks[role]!.getTracks().some((t) => t.readyState === "ended"),
      );
      if (ended.length)
        throw new Error(
          `${SOURCES[ended.includes("screen") ? "screen" : ended[0]]} stopped before the recording began. Press Start recording to try again.`,
        );
      finishing.current = false;
      const recording = new RecordingEngine(session);
      engine.current = recording;
      // The engine stops the take itself; the timer below then finishes it.
      recording.onFailure = (message) => {
        failure.current = message;
        setError(message);
      };
      recording.onNotice = (message) => {
        setLost((all) => (all.includes(message) ? all : [...all, message]));
        if (localStorage.getItem("relay-native-notifications") === "true")
          window.relayDesktop?.notify?.(message);
      };
      await recording.start();
      setPhase("recording");
      tick.current = setInterval(() => {
        const seconds = recording.seconds();
        setSeconds(seconds);
        setMeter(session.level());
        if (recording.stopped && mounted.current) {
          // Ended from outside (for example "Stop sharing"): finish the same way.
          clearInterval(tick.current);
          void finish();
        }
        window.relayDesktop?.captureState?.({
          active: !recording.stopped,
          paused: recording.paused,
          seconds,
          notes,
        });
      }, 200);
    } catch (e) {
      capture.current?.cleanup();
      // Undo a half-started take: no stray draft, and no hidden window or bubble.
      const failed = engine.current;
      engine.current = null;
      if (failed?.id) {
        await failed.stop().catch(() => undefined);
        await discardDraft(failed.id).catch(() => {});
      }
      window.relayDesktop?.captureState?.({
        active: false,
        paused: false,
        seconds: 0,
        notes: "",
      });
      // Closing the browser's screen picker is a change of mind, not a failure.
      const err = e as Error;
      // Only the screen picker throws a bare refusal now; devices explain themselves.
      setError(
        /by system/i.test(err.message)
          ? "Your computer is blocking screen recording for this browser. On a Mac, open System Settings → Privacy & Security → Screen & System Audio Recording, turn it on for your browser, then try again."
          : err.name === "NotAllowedError" ||
              /permission denied/i.test(err.message)
            ? ""
            : err.message,
      );
      setPhase("setup");
    }
  };
  const begin = async () => {
    if (window.relayDesktop && mode !== "camera") {
      setScreenBlocked(false);
      try {
        setSources(await window.relayDesktop.sources());
      } catch (e) {
        if (/screen-permission|Failed to get sources/.test(String(e)))
          setScreenBlocked(true);
        else setError("Relay couldn’t list your screens. Try again.");
      }
    } else await start();
  };
  const save = async () => {
    const id = draft?.id || engine.current?.id;
    if (!id) return;
    setPhase("saving");
    let v: Clip;
    try {
      await queueDraft(
        id,
        title ||
          `Recording · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`,
        seconds,
        draft?.meta,
      );
      v = await waitForDraft(id, setProgress);
    } catch (e) {
      setError((e as Error).message);
      setPhase("review");
      return;
    }
    // "Continue in background" closed this dialog: the video is in the library
    // and nothing more happens here.
    if (!mounted.current) return;
    // From here the video is saved. A link that can't be made must not hold it up.
    let copied = false,
      linkFailed = false;
    if (autoShare && !isLocal) {
      try {
        v = await api<Clip>(`/api/videos/${v.id}/share`, { method: "POST" });
      } catch {
        linkFailed = true;
      }
      if (!linkFailed && mounted.current)
        try {
          await navigator.clipboard.writeText(
            `${location.origin}/s/${v.token}`,
          );
          copied = true;
        } catch {
          /* The link remains available in Share. */
        }
    }
    if (mounted.current) onSaved(v, copied, linkFailed);
  };
  return (
    <div className="recorder-body">
      <h2>
        {phase === "review" || phase === "saving"
          ? "Name your recording"
          : "New recording"}
      </h2>
      {(phase === "review" || phase === "saving") && (
        <p className="muted">
          {clock(seconds)} recorded and safely stored. Give it a name, then open
          it to tidy up and send.
        </p>
      )}
      {sources ? (
        <div className="source-picker">
          <h3>Choose what to share</h3>
          <div className="sources">
            {sources.map((s) => (
              <button
                key={s.id}
                onClick={async () => {
                  try {
                    await window.relayDesktop!.selectSource(s.id);
                    let selected: Region;
                    if (crop && window.relayDesktop?.selectRegion) {
                      const r = await window.relayDesktop.selectRegion(s.id);
                      if (!r) return;
                      selected = r;
                    }
                    setSources(null);
                    void start(selected);
                  } catch (e) {
                    setError((e as Error).message);
                    setSources(null);
                  }
                }}
              >
                <img src={s.thumbnail} alt="" />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setSources(null)}>
            Back
          </button>
        </div>
      ) : (
        <>
          <div className={`capture-preview ${phase}`}>
            <video
              ref={preview}
              muted
              playsInline
              hidden={
                phase === "setup" || phase === "review" || phase === "saving"
              }
            />
            {count !== null && (
              <button
                className="recorder-countdown"
                onClick={() => countdownDone.current?.(true)}
                aria-label={`Starting in ${count}. Click to start now.`}
                autoFocus
              >
                <span>
                  {count}
                  <small>Click to start now · Esc to cancel</small>
                </span>
              </button>
            )}
            {["setup", "preparing"].includes(phase) && count === null && (
              <div className="preview-placeholder">
                <div className="capture-art">
                  <Monitor size={55} strokeWidth={1.1} />
                  <span>
                    <Camera size={23} />
                  </span>
                </div>
                <strong>Ready when you are</strong>
                <span>You’ll choose what to share after pressing Start.</span>
              </div>
            )}
            {(phase === "review" || phase === "saving") && (
              <div className="preview-placeholder">
                <Check size={38} />
                <strong>Saved on this device</strong>
                <span>{clock(seconds)} · Safe even if you close Relay now</span>
              </div>
            )}
            {["recording", "paused"].includes(phase) && (
              <div className="rec-live">
                <i className={phase === "paused" ? "paused" : ""} />
                {phase === "paused" ? "Paused" : "Recording"}{" "}
                <b>{clock(seconds)}</b>
                <span
                  className={`audio-meter ${meter > 0.92 ? "is-loud" : ""}`}
                >
                  <i style={{ width: `${meter * 100}%` }} />
                </span>
              </div>
            )}
            {phase === "preparing" && count === null && (
              <div className="preparing">
                <LoaderCircle className="spin" />
                {engine.current
                  ? "Finishing your recording…"
                  : "Choose what to share in the window that opened…"}
              </div>
            )}
          </div>
          {phase === "setup" && (
            <>
              {!canCaptureScreen && (
                <p className="studio-hint">
                  Phones and tablets can’t record their screen in a browser. Use
                  your device’s own screen recorder, then choose Upload to edit
                  it here.
                </p>
              )}
              <div
                className="mode-options"
                role="radiogroup"
                aria-label="What to record"
              >
                {(
                  [
                    ["screen-camera", "Screen + camera", Monitor],
                    ["screen", "Screen only", Monitor],
                    ["camera", "Camera only", Video],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
                    {...radio(mode === key)}
                    className={mode === key ? "selected" : ""}
                    disabled={key !== "camera" && !canCaptureScreen}
                    onClick={() => setMode(key)}
                  >
                    <Icon size={20} />
                    <span>{label}</span>
                    {mode === key && <Check size={14} />}
                  </button>
                ))}
              </div>
              <div className="rec-settings">
                <button className="btn" onClick={() => setMic(!mic)}>
                  {mic ? <Mic size={17} /> : <MicOff size={17} />}Microphone{" "}
                  {mic ? "on" : "off"}
                </button>
                <select
                  aria-label="Recording resolution"
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                >
                  <option value={1920}>1080p · Full HD</option>
                  <option value={3840}>4K · Ultra HD</option>
                  <option value={1280}>720p · Lightweight</option>
                </select>
              </div>
            </>
          )}
          {phase === "setup" && (
            <div className="recording-extra">
              <details className="recorder-more">
                <summary>Microphone, camera and sound check</summary>
                <div className="cut-more-body">
                  <div className="device-grid">
                    <label>
                      Microphone
                      <select
                        aria-label="Microphone device"
                        value={microphoneId}
                        onChange={(e) => setMicrophoneId(e.target.value)}
                      >
                        <option value="">System default</option>
                        {devices
                          .filter((d) => d.kind === "audioinput")
                          .map((d, i) => (
                            <option key={d.deviceId || i} value={d.deviceId}>
                              {d.label || `Microphone ${i + 1}`}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      Camera
                      <select
                        aria-label="Camera device"
                        value={cameraId}
                        onChange={(e) => setCameraId(e.target.value)}
                      >
                        <option value="">System default</option>
                        {devices
                          .filter((d) => d.kind === "videoinput")
                          .map((d, i) => (
                            <option key={d.deviceId || i} value={d.deviceId}>
                              {d.label || `Camera ${i + 1}`}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <div className="actions">
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={systemAudio}
                        onChange={(e) => setSystemAudio(e.target.checked)}
                      />
                      Record computer sound
                    </label>
                    {window.relayDesktop && (
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={crop}
                          onChange={(e) => setCrop(e.target.checked)}
                        />
                        <Crop size={14} />
                        Select a region
                      </label>
                    )}
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          const s = await openInput(
                            "microphone",
                            microphoneId,
                            {},
                            () => setMicrophoneId(""),
                          );
                          const a = new AudioContext(),
                            meter = a.createAnalyser();
                          a.createMediaStreamSource(s).connect(meter);
                          let loudest = 0;
                          setMicTest("Say something…");
                          const t = setInterval(() => {
                            const values = new Uint8Array(meter.fftSize);
                            meter.getByteTimeDomainData(values);
                            const level = Math.min(
                              1,
                              Math.sqrt(
                                values.reduce(
                                  (n, v) => n + ((v - 128) / 128) ** 2,
                                  0,
                                ) / values.length,
                              ) * 4,
                            );
                            loudest = Math.max(loudest, level);
                            setMeter(level);
                          }, 100);
                          setTimeout(() => {
                            clearInterval(t);
                            s.getTracks().forEach((t) => t.stop());
                            void a.close();
                            setMeter(0);
                            setMicTest(
                              loudest > 0.08
                                ? "Your microphone is working."
                                : "No sound picked up. Check the microphone chosen above.",
                            );
                          }, 3000);
                          setDevices(
                            await navigator.mediaDevices.enumerateDevices(),
                          );
                        } catch (e) {
                          setError((e as Error).message);
                        }
                      }}
                    >
                      Test microphone
                    </button>
                    <span
                      className={`audio-meter ${meter > 0.92 ? "is-loud" : ""}`}
                      aria-hidden="true"
                    >
                      <i style={{ width: `${meter * 100}%` }} />
                    </span>
                    <span className="small muted" role="status">
                      {micTest}
                    </span>
                  </div>
                </div>
              </details>
              {mode !== "screen" && (
                <div className="field small">
                  Camera look
                  <CameraLookPicker
                    cameraId={cameraId}
                    look={look}
                    onChange={setLook}
                    size={112}
                  />
                </div>
              )}
              {window.relayDesktop && mode !== "camera" && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={autoZoom}
                    onChange={(e) => setAutoZoom(e.target.checked)}
                  />
                  Auto-zoom into key moments
                  <span className="small muted">
                    · follows where you point, editable after
                  </span>
                </label>
              )}
              {window.relayDesktop && (
                <details className="recorder-more">
                  <summary>Speaker notes</summary>
                  <label className="field small">
                    <span className="sr-only">Speaker notes</span>
                    <textarea
                      aria-label="Speaker notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Your talking points. Only you see them while recording."
                      rows={2}
                    />
                  </label>
                </details>
              )}
            </div>
          )}
          {["recording", "paused"].includes(phase) && (
            <div className="rec-take-row">
              <button
                className="text-button"
                onClick={() => {
                  engine.current?.retake();
                  setNotice("The last 10 seconds will be cut. Keep recording.");
                }}
              >
                <RotateCcw size={14} />
                Retake last 10s
              </button>
              <span className="small muted">
                Saved every second as you record
              </span>
            </div>
          )}
          {(phase === "review" || phase === "saving") && (
            <label className="field">
              Video title
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Give your video a name"
                maxLength={160}
              />
            </label>
          )}
          {/* A link to this computer only opens here, so it is never offered as a way to share. */}
          {phase === "review" && !isLocal && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={autoShare}
                onChange={(e) => setAutoShare(e.target.checked)}
              />
              Copy a share link when it’s ready
            </label>
          )}
          {screenBlocked && (
            <div className="error screen-blocked" role="alert">
              <p>
                macOS isn’t letting Relay record the screen. Turn Relay on in
                System Settings → Privacy & Security → Screen & System Audio
                Recording, then reopen Relay.
              </p>
              <p>
                Already switched on? That can be a leftover from an older copy
                of Relay. Resetting it makes macOS ask again.
              </p>
              <div className="actions">
                <button
                  className="btn small"
                  onClick={() =>
                    void window.relayDesktop?.openPermissionSettings?.("screen")
                  }
                >
                  Open System Settings
                </button>
                {window.relayDesktop?.resetScreenPermission && (
                  <button
                    className="btn small"
                    onClick={() =>
                      void window.relayDesktop?.resetScreenPermission?.()
                    }
                  >
                    Reset and reopen Relay
                  </button>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {phase !== "setup" &&
            lost.map((message) => (
              <p className="rec-notice is-warning" role="alert" key={message}>
                {message}
              </p>
            ))}
          {notice && ["recording", "paused"].includes(phase) && (
            <p className="rec-notice">{notice}</p>
          )}
          <p className="sr-only" role="status">
            {phase === "recording"
              ? "Recording"
              : phase === "paused"
                ? "Recording paused"
                : phase === "review"
                  ? "Recording saved"
                  : phase === "saving"
                    ? "Saving"
                    : ""}{" "}
            {notice}
          </p>
          <div className="recorder-bottom">
            <span className="small muted">
              {["recording", "paused"].includes(phase) ? (
                "Recording. Come back to this tab and press Finish when you’re done."
              ) : (
                <>
                  <span className="tiny-dot" />
                  {phase === "setup" && mode !== "camera"
                    ? "You’ll choose which screen or window after pressing Start. When you’re done, come back to this tab and press Finish."
                    : "Saved on this device as you record."}
                </>
              )}
            </span>
            <div className="actions">
              {phase === "setup" && (
                <button className="btn primary" onClick={() => void begin()}>
                  <span className="record-dot" />
                  Start recording
                </button>
              )}
              {["recording", "paused"].includes(phase) && (
                <>
                  <button className="btn" onClick={pause} autoFocus>
                    {phase === "paused" ? (
                      <Play size={16} />
                    ) : (
                      <Pause size={16} />
                    )}{" "}
                    {phase === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button className="btn primary" onClick={() => void finish()}>
                    <Square size={15} fill="currentColor" />
                    Finish recording
                  </button>
                </>
              )}
              {(phase === "review" || phase === "saving") && (
                <>
                  <button
                    className="btn"
                    disabled={phase === "saving"}
                    onClick={async () => {
                      try {
                        if (
                          !(await confirmDialog({
                            title: "Discard this recording?",
                            body: "It will be deleted. You can’t undo this.",
                            confirm: "Discard",
                            cancel: "Keep it",
                            destructive: true,
                          }))
                        )
                          return;
                        if (draft) await discardDraft(draft.id);
                        onClose();
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Discard
                  </button>
                  <button
                    className="btn primary"
                    disabled={phase === "saving"}
                    onClick={() => void save()}
                  >
                    {phase === "saving" ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <ArrowUpRight size={16} />
                    )}{" "}
                    {phase === "saving"
                      ? `Preparing your video… ${progress}`
                      : "Open in editor"}
                  </button>
                  {phase === "saving" && (
                    <button className="text-button" onClick={onClose}>
                      Continue in background
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
