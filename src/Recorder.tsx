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
  ChevronRight,
  RotateCcw,
  Crop,
} from "lucide-react";
import { acquireCapture, type CaptureSession } from "./media";
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

export function Recorder({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (c: Clip, copied?: boolean) => void;
}) {
  const saved = cachedPreferences();
  const canCaptureScreen =
    typeof navigator.mediaDevices?.getDisplayMedia === "function";
  const [mode, setModeState] = useState<Mode>(
      canCaptureScreen ? saved.mode || "screen-camera" : "camera",
    ),
    [mic, setMic] = useState(true),
    [quality, setQualityState] = useState<number>(pref("quality")),
    [phase, setPhase] = useState("setup"),
    [seconds, setSeconds] = useState(0),
    [error, setError] = useState(""),
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
    [notes, setNotes] = useState(""),
    [meter, setMeter] = useState(0),
    [crop, setCrop] = useState(false),
    [region, setRegion] = useState<
      { x: number; y: number; w: number; h: number } | undefined
    >(),
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
    setSystemAudio = (v: boolean) => {
      setSystemAudioState(v);
      void savePreferences({ systemAudio: v });
    };
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
  const preview = useRef<HTMLVideoElement>(null),
    engine = useRef<RecordingEngine | null>(null),
    capture = useRef<CaptureSession | null>(null),
    tick = useRef<ReturnType<typeof setInterval> | undefined>(undefined),
    mounted = useRef(true);
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => {});
    return () => {
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
  const finish = async () => {
    try {
      setPhase("preparing");
      // Read the on-screen bubble position before the native surfaces close.
      const camera = await window.relayDesktop
        ?.cameraLayout?.()
        .catch(() => null);
      let d = await engine.current?.stop();
      if (d && camera)
        d = await updateDraft(d.id, {
          meta: {
            ...d.meta,
            layout: {
              ...(d.meta.layout || {}),
              camera,
            } as Draft["meta"]["layout"],
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
        setError(d.error || "");
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
          setError("The previous 10 seconds will be cut. Keep recording.");
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
  const start = async (selectedRegion?: typeof region) => {
    setError("");
    setPhase("preparing");
    try {
      const session = await acquireCapture(mode, mic, quality, {
        microphoneId,
        cameraId,
        systemAudio,
        region: selectedRegion,
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
                cameraId,
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
      const recording = new RecordingEngine(session);
      engine.current = recording;
      recording.onFailure = (message) => {
        setError(message);
        setPhase("paused");
      };
      await recording.start();
      setPhase("recording");
      tick.current = setInterval(() => {
        const seconds = recording.seconds();
        setSeconds(seconds);
        setMeter(session.level());
        if (recording.stopped && mounted.current) {
          clearInterval(tick.current);
          void recording.stop().then((d) => {
            if (d) {
              setDraft(d);
              setPhase("review");
            }
          });
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
      setError((e as Error).message);
      setPhase("setup");
    }
  };
  const begin = async () => {
    if (window.relayDesktop && mode !== "camera") {
      try {
        setSources(await window.relayDesktop.sources());
      } catch (e) {
        setError(String(e));
      }
    } else await start();
  };
  const save = async () => {
    const id = draft?.id || engine.current?.id;
    if (!id) return;
    setPhase("saving");
    let copied = false;
    try {
      await queueDraft(
        id,
        title ||
          `Recording · ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`,
        seconds,
        draft?.meta,
      );
      let v = await waitForDraft(id, setProgress);
      if (autoShare) {
        v = await api<Clip>(`/api/videos/${v.id}/share`, { method: "POST" });
        try {
          await navigator.clipboard.writeText(
            `${location.origin}/s/${v.token}`,
          );
          copied = true;
        } catch {
          /* The link remains available in Share. */
        }
      }
      if (mounted.current) onSaved(v, copied);
    } catch (e) {
      setError((e as Error).message);
      setPhase("review");
    }
  };
  return (
    <div className="recorder-body">
      <div className="eyebrow">THE FLOOR IS YOURS</div>
      <h2>
        {phase === "review" || phase === "saving"
          ? "That’s a wrap."
          : "Show it. Say it. Send it."}
      </h2>
      <p className="muted">
        {phase === "review" || phase === "saving"
          ? "Give your video a name. You can trim it in the editor next."
          : "A little context goes a long way."}
      </p>
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
                    let selected: typeof region = undefined;
                    if (crop && window.relayDesktop?.selectRegion) {
                      const r = await window.relayDesktop.selectRegion(s.id);
                      if (!r) return;
                      selected = r;
                      setRegion(r);
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
                aria-live="assertive"
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
                <strong>Your next great explanation starts here.</strong>
                <span>Choose a screen, window or browser tab.</span>
              </div>
            )}
            {(phase === "review" || phase === "saving") && (
              <div className="preview-placeholder">
                <Check size={38} />
                <strong>Your source tracks are saved.</strong>
                <span>{clock(seconds)} · Recoverable on this device</span>
              </div>
            )}
            {["recording", "paused"].includes(phase) && (
              <div className="rec-live">
                <i className={phase === "paused" ? "paused" : ""} />
                {phase === "paused" ? "Paused" : "Recording"}{" "}
                <b>{clock(seconds)}</b>
                <span className={`audio-meter ${meter > 0.92 ? "is-loud" : ""}`}>
                  <i style={{ width: `${meter * 100}%` }} />
                </span>
              </div>
            )}
            {phase === "preparing" && count === null && (
              <div className="preparing">
                <LoaderCircle className="spin" />
                {engine.current
                  ? "Saving the final source chunks…"
                  : "Waiting for capture permission…"}
              </div>
            )}
          </div>
          {phase === "setup" && (
            <>
              {!canCaptureScreen && (
                <p className="studio-hint">
                  This browser supports camera recording. Import a native screen
                  recording from your device to edit it here.
                </p>
              )}
              <div className="mode-options">
                {(
                  [
                    ["screen-camera", "Screen + camera", Monitor],
                    ["screen", "Screen only", Monitor],
                    ["camera", "Camera only", Video],
                  ] as const
                ).map(([key, label, Icon]) => (
                  <button
                    key={key}
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
                  System audio
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
                      const s = await navigator.mediaDevices.getUserMedia({
                        audio: {
                          deviceId: microphoneId
                            ? { exact: microphoneId }
                            : undefined,
                        },
                      });
                      const a = new AudioContext(),
                        meter = a.createAnalyser();
                      a.createMediaStreamSource(s).connect(meter);
                      const t = setInterval(() => {
                        const values = new Uint8Array(meter.fftSize);
                        meter.getByteTimeDomainData(values);
                        setMeter(
                          Math.min(
                            1,
                            Math.sqrt(
                              values.reduce(
                                (n, v) => n + ((v - 128) / 128) ** 2,
                                0,
                              ) / values.length,
                            ) * 4,
                          ),
                        );
                      }, 100);
                      setTimeout(() => {
                        clearInterval(t);
                        s.getTracks().forEach((t) => t.stop());
                        void a.close();
                        setMeter(0);
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
                <span className={`audio-meter ${meter > 0.92 ? "is-loud" : ""}`}>
                  <i style={{ width: `${meter * 100}%` }} />
                </span>
              </div>
              <label className="field small">
                Speaker notes
                <textarea
                  aria-label="Speaker notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Your talking points. Visible in the desktop teleprompter."
                  rows={2}
                />
              </label>
            </div>
          )}
          {["recording", "paused"].includes(phase) && (
            <div className="rec-take-row">
              <button
                className="text-button"
                onClick={() => {
                  engine.current?.retake();
                  setError(
                    "Previous 10 seconds marked for removal. Keep recording.",
                  );
                }}
              >
                <RotateCcw size={14} />
                Retake last 10s
              </button>
              <span className="small muted">
                Separate tracks · Checkpointed every second
              </span>
            </div>
          )}
          {(phase === "review" || phase === "saving") && (
            <label className="field">
              Video title
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What’s this video about?"
                maxLength={160}
              />
            </label>
          )}
          {phase === "review" && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={autoShare}
                onChange={(e) => setAutoShare(e.target.checked)}
              />
              Create a share link and copy it when ready
            </label>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="recorder-bottom">
            <span className="small muted">
              {["recording", "paused"].includes(phase) ? (
                "Make it a good one. No rush."
              ) : (
                <>
                  <span className="tiny-dot" />
                  Saved locally as you record.
                </>
              )}
            </span>
            <div className="actions">
              {phase === "setup" && (
                <button className="btn primary" onClick={() => void begin()}>
                  <span className="record-dot" />
                  Start recording
                  <ChevronRight size={16} />
                </button>
              )}
              {["recording", "paused"].includes(phase) && (
                <>
                  <button className="btn" onClick={pause}>
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
                      if (draft) await discardDraft(draft.id);
                      onClose();
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
                    {phase === "saving" ? `Saving… ${progress}` : "Save & edit"}
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
