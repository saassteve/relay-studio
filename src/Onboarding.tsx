import { radio, useDialog } from "./Modal";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Camera,
  Check,
  CircleAlert,
  Cpu,
  Download,
  HardDrive,
  Infinity as Unlimited,
  Keyboard,
  LoaderCircle,
  Lock,
  Mic,
  Monitor,
  PenLine,
  RotateCw,
  Settings,
  Sparkles,
  Volume2,
} from "lucide-react";
import { api, type Job, type BubbleSize } from "./types";
import { defaults, savePreferences, type Preferences } from "./prefs";
import { CameraLookPicker } from "./CameraLook";
import "./onboarding.css";
// A link to this computer only opens here, so setup doesn't promise one.
const local = ["127.0.0.1", "localhost"].includes(location.hostname);

type Step = "welcome" | "name" | "permissions" | "check" | "prefs" | "ready";
type Permission =
  "granted" | "denied" | "restricted" | "not-determined" | "unknown";
export type OnboardingExit = "record" | "sample" | "library";

const isMac = () => window.relayDesktop?.platform === "darwin";
const steps = (): Step[] =>
  window.relayDesktop
    ? ["welcome", "name", "permissions", "check", "prefs", "ready"]
    : ["welcome", "name", "check", "prefs", "ready"];
const labels: Record<Step, string> = {
  welcome: "Welcome",
  name: "About you",
  permissions: "Permissions",
  check: "Camera & mic",
  prefs: "Your way",
  ready: "Ready",
};

export function Onboarding({
  initialName,
  preferences,
  onName,
  onDone,
}: {
  initialName: string;
  preferences: Preferences;
  onName: (name: string) => void;
  onDone: (exit: OnboardingExit) => void;
}) {
  const order = steps();
  const resume = order.includes(preferences.onboardingStep as Step)
    ? (preferences.onboardingStep as Step)
    : "welcome";
  const [step, setStep] = useState<Step>(resume),
    [name, setName] = useState(
      initialName && initialName !== "Workspace owner" ? initialName : "",
    ),
    [error, setError] = useState(""),
    [prefs, setPrefs] = useState<Preferences>(preferences);
  const index = order.indexOf(step);
  const go = useCallback(
    (next: Step) => {
      setError("");
      setStep(next);
      void savePreferences({ onboardingStep: next });
    },
    [setStep],
  );
  const forward = () => go(order[Math.min(order.length - 1, index + 1)]);
  const back = () => go(order[Math.max(0, index - 1)]);
  const update = (next: Partial<Preferences>) => {
    setPrefs((p) => ({ ...p, ...next }));
    void savePreferences(next);
  };
  const leaving = useRef(false);
  const finish = async (exit: OnboardingExit) => {
    if (leaving.current) return;
    leaving.current = true;
    await savePreferences({ onboarded: true, onboardingStep: null });
    onDone(exit);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") void finish("library");
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  });
  const dialog = useRef<HTMLDivElement>(null);
  useDialog(dialog);
  // Each step starts at its heading, so it is announced and Tab continues from there.
  useEffect(() => {
    const stage =
      dialog.current?.querySelector<HTMLElement>(".onboarding-stage");
    const heading = stage?.querySelector<HTMLElement>("h1");
    if (!stage || !heading || stage.contains(document.activeElement)) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [step]);
  // Outside the app root, so the page behind is out of reach while this is open.
  return createPortal(
    <div
      ref={dialog}
      className="onboarding"
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Set up Relay"
    >
      <aside className="onboarding-rail">
        <span className="onboarding-mark" aria-hidden="true">
          <svg viewBox="0 0 34 36">
            <path d="M3 3h13a15 15 0 0 1 0 30H3V3Z" fill="currentColor" />
            <path d="m12 11 12 7-12 7Z" fill="#173e32" />
          </svg>
          relay
        </span>
        <ol>
          {order.map((s, i) => (
            <li
              key={s}
              className={
                i < index ? "done" : i === index ? "current" : undefined
              }
              aria-current={i === index ? "step" : undefined}
            >
              <span>{i < index ? <Check size={12} /> : i + 1}</span>
              {labels[s]}
            </li>
          ))}
        </ol>
        <p>
          Open source and local-first. Your recordings stay on this
          {window.relayDesktop
            ? " Mac"
            : ["127.0.0.1", "localhost"].includes(location.hostname)
              ? " computer"
              : " server"}{" "}
          until you share them.
        </p>
      </aside>
      <main className="onboarding-stage" key={step}>
        {step === "welcome" && (
          <Welcome onNext={forward} onSkip={() => void finish("library")} />
        )}
        {step === "name" && (
          <form
            className="onboarding-panel"
            onSubmit={async (e) => {
              e.preventDefault();
              const clean = name.trim();
              if (!clean)
                return setError("Add a name so people know who’s talking.");
              try {
                await api("/api/profile", {
                  method: "PUT",
                  body: JSON.stringify({ name: clean }),
                });
                onName(clean);
                forward();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <span className="eyebrow">STEP {index + 1}</span>
            <h1>What should we call you?</h1>
            <p className="lede">
              Your name appears on comments, replies and anything you share.
            </p>
            <label className="field big-field">
              Your name
              <input
                autoFocus
                required
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Rivera"
                autoComplete="name"
              />
            </label>
            <div className="name-preview" aria-hidden="true">
              <span className="avatar owner">
                {(name.trim()[0] || "?").toUpperCase()}
              </span>
              <span>
                <strong>{name.trim() || "You"}</strong>
                <small>at 0:42 · “Here’s the bit I wanted you to see.”</small>
              </span>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            <Footer onBack={back}>
              <button className="btn primary big">
                Continue <ArrowRight size={16} />
              </button>
            </Footer>
          </form>
        )}
        {step === "permissions" && (
          <Permissions index={index} onBack={back} onNext={forward} />
        )}
        {step === "check" && (
          <DeviceCheck
            index={index}
            prefs={prefs}
            update={update}
            onBack={back}
            onNext={forward}
          />
        )}
        {step === "prefs" && (
          <PrefsStep
            index={index}
            prefs={prefs}
            update={update}
            onBack={back}
            onNext={forward}
          />
        )}
        {step === "ready" && (
          <div className="onboarding-panel ready-panel">
            <div className="ready-burst" aria-hidden="true">
              <span />
              <span />
              <span />
              <Check size={34} />
            </div>
            <h1>
              You’re all set
              {name.trim() ? `, ${name.trim().split(" ")[0]}` : ""}.
            </h1>
            <p className="lede">
              {window.relayDesktop ? (
                <>
                  Press <kbd>⌥</kbd>
                  <kbd>⇧</kbd>
                  <kbd>R</kbd> from anywhere to record. Relay also lives in your
                  menu bar, so it’s one click away.
                </>
              ) : (
                <>
                  Press <kbd>R</kbd> in your library to start a recording at any
                  time.
                </>
              )}
            </p>
            <div className="ready-actions">
              <button
                className="btn primary big"
                autoFocus
                onClick={() => void finish("record")}
              >
                <span className="record-dot" />
                Record your first video
              </button>
              <button className="btn big" onClick={() => void finish("sample")}>
                <Sparkles size={16} />
                Explore a sample first
              </button>
            </div>
            <button
              className="text-button muted"
              onClick={() => void finish("library")}
            >
              Take me to my library
            </button>
          </div>
        )}
      </main>
    </div>,
    document.body,
  );
}

function Footer({
  onBack,
  children,
  note,
}: {
  onBack?: () => void;
  children: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="onboarding-footer">
      {onBack ? (
        <button type="button" className="text-button" onClick={onBack}>
          <ArrowLeft size={15} /> Back
        </button>
      ) : (
        <span />
      )}
      <span className="footer-note">{note}</span>
      {children}
    </div>
  );
}

function Welcome({
  onNext,
  onSkip,
}: {
  onNext: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="onboarding-panel welcome-panel">
      <span className="eyebrow">WELCOME TO RELAY</span>
      <h1>
        Say it once.
        <br />
        <em>Keep it forever.</em>
      </h1>
      <p className="lede">
        Record your screen, camera and voice, edit by deleting words, and{" "}
        {local ? "send the finished video" : "send one link"}. Relay does it on
        your own machine, with no plan limits.
      </p>
      <div className="promise-grid">
        <div>
          <Unlimited size={20} />
          <strong>No caps</strong>
          <span>No 5-minute limit, no video quota, 4K included.</span>
        </div>
        <div>
          <Lock size={20} />
          <strong>Private by default</strong>
          <span>Footage stays local until you choose to share.</span>
        </div>
        <div>
          <Cpu size={20} />
          <strong>On-device AI</strong>
          <span>Transcripts, captions and summaries without a cloud.</span>
        </div>
        <div>
          <HardDrive size={20} />
          <strong>Nothing lost</strong>
          <span>Every take is saved to disk each second as you record.</span>
        </div>
      </div>
      <Footer note="Takes about a minute.">
        <button type="button" className="text-button muted" onClick={onSkip}>
          Skip setup
        </button>
        <button className="btn primary big" autoFocus onClick={onNext}>
          Let’s get set up <ArrowRight size={16} />
        </button>
      </Footer>
    </div>
  );
}

function Permissions({
  index,
  onBack,
  onNext,
}: {
  index: number;
  onBack: () => void;
  onNext: () => void;
}) {
  const [status, setStatus] = useState<{
    screen: Permission;
    camera: Permission;
    microphone: Permission;
    systemAudio: boolean;
  } | null>(null);
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const refresh = useCallback(async () => {
    const s = await window.relayDesktop?.permissionStatus?.();
    if (s) setStatus(s as typeof status);
  }, []);
  useEffect(() => {
    void refresh();
    // Users flip switches in System Settings; reflect them without a reload.
    const t = setInterval(() => void refresh(), 1500);
    addEventListener("focus", refresh);
    return () => {
      clearInterval(t);
      removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const request = async (kind: "screen" | "camera" | "microphone") => {
    setAsked((a) => ({ ...a, [kind]: true }));
    const result = await window.relayDesktop?.requestPermission?.(kind);
    await refresh();
    if (result !== "granted" && (kind === "screen" || result === "denied"))
      await window.relayDesktop?.openPermissionSettings?.(kind);
  };
  const rows: {
    kind: "screen" | "camera" | "microphone";
    icon: typeof Monitor;
    title: string;
    why: string;
  }[] = [
    {
      kind: "screen",
      icon: Monitor,
      title: "Screen Recording",
      why: "To capture the display, window or region you pick.",
    },
    {
      kind: "camera",
      icon: Camera,
      title: "Camera",
      why: "For your camera bubble. Only on while you record.",
    },
    {
      kind: "microphone",
      icon: Mic,
      title: "Microphone",
      why: "So people can hear you explain it.",
    },
  ];
  const allGranted =
    status &&
    rows.every(
      (r) => status[r.kind] === "granted" || status[r.kind] === "unknown",
    );
  const screenPending =
    isMac() && status && status.screen !== "granted" && asked.screen;
  return (
    <div className="onboarding-panel">
      <span className="eyebrow">STEP {index + 1}</span>
      <h1>A few quick permissions.</h1>
      <p className="lede">
        macOS asks once for each. Relay only uses them while you record, and
        nothing leaves this Mac unless you share it.
      </p>
      <div className="permission-list">
        {rows.map(({ kind, icon: Icon, title, why }) => {
          const s = status?.[kind] || "unknown";
          const granted = s === "granted";
          return (
            <div
              className={`permission-row ${granted ? "is-granted" : ""}`}
              key={kind}
              data-permission={kind}
            >
              <span className="permission-icon">
                <Icon size={19} />
              </span>
              <span className="permission-copy">
                <strong>{title}</strong>
                <small>{why}</small>
              </span>
              {granted ? (
                <span className="permission-state">
                  <Check size={14} /> Allowed
                </span>
              ) : (s === "denied" || s === "restricted") &&
                // macOS reports screen capture as "denied" before Relay has
                // ever asked, so screen always starts with Allow.
                (kind !== "screen" || asked.screen) ? (
                <button
                  className="btn small"
                  onClick={() =>
                    void window.relayDesktop?.openPermissionSettings?.(kind)
                  }
                >
                  <Settings size={14} /> Open Settings
                </button>
              ) : (
                <button
                  className="btn small primary"
                  aria-label={`Allow ${title}`}
                  onClick={() => void request(kind)}
                >
                  Allow
                </button>
              )}
            </div>
          );
        })}
        <div
          className={`permission-row ${status?.systemAudio ? "is-granted" : ""}`}
          data-permission="audio"
        >
          <span className="permission-icon">
            <Volume2 size={19} />
          </span>
          <span className="permission-copy">
            <strong>System audio</strong>
            <small>
              {status?.systemAudio
                ? "Supported. macOS asks the first time you record with it on."
                : "Needs macOS 14 or later. Your mic still works everywhere."}
            </small>
          </span>
          <span className="permission-state soft">Optional</span>
        </div>
      </div>
      {screenPending && (
        <div className="relaunch-card" role="status">
          <CircleAlert size={18} />
          <span>
            After you switch on <strong>Relay</strong> under Screen &amp; System
            Audio Recording, macOS needs Relay to reopen. Setup picks up right
            here.
          </span>
          <button
            className="btn small primary"
            onClick={() => void window.relayDesktop?.relaunch?.()}
          >
            <RotateCw size={14} /> Reopen Relay
          </button>
        </div>
      )}
      <Footer
        onBack={onBack}
        note={
          allGranted ? "Everything’s ready." : "You can change these later."
        }
      >
        <button className="btn primary big" onClick={onNext}>
          {allGranted ? "Continue" : "Continue for now"}{" "}
          <ArrowRight size={16} />
        </button>
      </Footer>
    </div>
  );
}

function DeviceCheck({
  index,
  prefs,
  update,
  onBack,
  onNext,
}: {
  index: number;
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [level, setLevel] = useState(0),
    [heard, setHeard] = useState(false),
    [loud, setLoud] = useState(false),
    [micError, setMicError] = useState("");
  const cameraId = prefs.cameraId || "",
    microphoneId = prefs.microphoneId || "";
  useEffect(() => {
    // Device names appear once a camera or mic has been allowed.
    const refresh = () =>
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then(setDevices)
        .catch(() => {});
    const t = setTimeout(refresh, 1200);
    return () => clearTimeout(t);
  }, [cameraId]);
  useEffect(() => {
    let stream: MediaStream | undefined,
      context: AudioContext | undefined,
      timer: ReturnType<typeof setInterval> | undefined,
      cancelled = false,
      hot = 0;
    setMicError("");
    setHeard(false);
    navigator.mediaDevices
      ?.getUserMedia({
        audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
      })
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(s).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        timer = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let sum = 0,
            peak = 0;
          for (const v of data) {
            const x = (v - 128) / 128;
            sum += x * x;
            peak = Math.max(peak, Math.abs(x));
          }
          const rms = Math.min(1, Math.sqrt(sum / data.length) * 4);
          setLevel(rms);
          if (rms > 0.18) setHeard(true);
          hot = peak > 0.97 ? hot + 1 : Math.max(0, hot - 1);
          setLoud(hot > 6);
        }, 80);
        setDevices(await navigator.mediaDevices.enumerateDevices());
      })
      .catch((e) =>
        setMicError(
          e.name === "NotAllowedError"
            ? window.relayDesktop
              ? "Microphone access is off. Turn it on in Permissions to be heard."
              : "Microphone access is off. Allow it for this site in your browser’s address bar."
            : "No microphone found.",
        ),
      );
    return () => {
      cancelled = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
      if (context && context.state !== "closed") void context.close();
    };
  }, [microphoneId]);
  const bars = 18;
  return (
    <div className="onboarding-panel">
      <span className="eyebrow">STEP {index + 1}</span>
      <h1>Looking good. Sounding good?</h1>
      <p className="lede">
        Pick a camera look and a microphone, then say hello. Backgrounds and
        filters run on your device and apply to every recording.
      </p>
      <div className="check-grid">
        <div className="check-camera">
          <CameraLookPicker
            cameraId={cameraId}
            look={{
              filter: prefs.cameraFilter || "none",
              background: prefs.cameraBackground || "none",
            }}
            onChange={(l) =>
              update({ cameraFilter: l.filter, cameraBackground: l.background })
            }
            size={150}
          />
          <label className="field small">
            Camera
            <select
              aria-label="Onboarding camera"
              value={cameraId}
              onChange={(e) => update({ cameraId: e.target.value })}
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
        <div className="check-mic">
          <div
            className={`level-bars ${loud ? "is-loud" : heard ? "is-good" : ""}`}
            aria-hidden="true"
          >
            {Array.from({ length: bars }, (_, i) => (
              <i
                key={i}
                className={level * bars * 1.4 > i ? "on" : undefined}
              />
            ))}
          </div>
          <p className="check-status" role="status">
            {micError ? (
              micError
            ) : loud ? (
              <>
                <CircleAlert size={15} /> A little loud. Move back or lower your
                input level.
              </>
            ) : heard ? (
              <>
                <Check size={15} /> Sounds great.
              </>
            ) : (
              <>
                <AudioLines size={15} /> Say something…
              </>
            )}
          </p>
          <label className="field small">
            Microphone
            <select
              aria-label="Onboarding microphone"
              value={microphoneId}
              onChange={(e) => update({ microphoneId: e.target.value })}
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
        </div>
      </div>
      <Footer onBack={onBack}>
        <button className="btn primary big" onClick={onNext}>
          Continue <ArrowRight size={16} />
        </button>
      </Footer>
    </div>
  );
}

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  // One option is not a choice: just say what will happen.
  if (options.length === 1)
    return <span className="choice-only">{options[0][1]}</span>;
  return (
    <div className="choice" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button
          key={String(v)}
          type="button"
          {...radio(value === v)}
          className={value === v ? "selected" : undefined}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function PrefsStep({
  index,
  prefs,
  update,
  onBack,
  onNext,
}: {
  index: number;
  prefs: Preferences;
  update: (p: Partial<Preferences>) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const desktop = Boolean(window.relayDesktop);
  const [ai, setAi] = useState<{ status: string; progress: number }>({
    status: "checking",
    progress: 0,
  });
  useEffect(() => {
    void api<{
      supported?: boolean;
      models: { model: string; ready: boolean }[];
    }>("/api/ai/status")
      .then((s) =>
        setAi({
          status:
            s.supported === false
              ? "unsupported"
              : s.models.find((m) => m.model === "Xenova/whisper-tiny.en")
                    ?.ready
                ? "complete"
                : "idle",
          progress: 0,
        }),
      )
      .catch(() => setAi({ status: "idle", progress: 0 }));
  }, []);
  const prepare = async () => {
    setAi({ status: "running", progress: 2 });
    try {
      let job = await api<Job | { status: "complete"; progress: number }>(
        "/api/ai/prepare",
        { method: "POST", body: JSON.stringify({}) },
      );
      while (
        job.status !== "complete" &&
        job.status !== "failed" &&
        "id" in job
      ) {
        await new Promise((r) => setTimeout(r, 900));
        job = await api<Job>(`/api/jobs/${job.id}`);
        setAi({ status: "running", progress: job.progress });
      }
      setAi({
        status: job.status === "complete" ? "complete" : "failed",
        progress: 100,
      });
    } catch {
      setAi({ status: "failed", progress: 0 });
    }
  };
  const v = <K extends keyof typeof defaults>(k: K) =>
    (prefs[k as keyof Preferences] ?? defaults[k]) as (typeof defaults)[K];
  return (
    <div className="onboarding-panel">
      <span className="eyebrow">STEP {index + 1}</span>
      <h1>Make it yours.</h1>
      <p className="lede">
        Sensible defaults. You can change them any time in Settings.
      </p>
      <div className="pref-list">
        <div className="pref-row">
          <span>
            <strong>When I finish recording</strong>
            <small>
              {local
                ? "Open the editor to tidy it up, then download or share it."
                : "Paste the link anywhere. It plays while you polish."}
            </small>
          </span>
          <Choice
            label="When I finish recording"
            value={local ? "open-editor" : v("afterRecording")}
            options={[
              ...(local
                ? []
                : ([["copy-link", "Copy link + open editor"]] as [
                    "copy-link",
                    string,
                  ][])),
              ["open-editor", local ? "Open the editor" : "Just open editor"],
            ]}
            onChange={(afterRecording) => update({ afterRecording })}
          />
        </div>
        <div className="pref-row">
          <span>
            <strong>Countdown</strong>
            <small>A breath before you go live.</small>
          </span>
          <Choice
            label="Countdown"
            value={v("countdown")}
            options={[
              [0, "Off"],
              [3, "3 sec"],
              [5, "5 sec"],
            ]}
            onChange={(countdown) => update({ countdown })}
          />
        </div>
        <div className="pref-row">
          <span>
            <strong>Quality</strong>
            <small>4K is included. 1080p keeps files lighter.</small>
          </span>
          <Choice
            label="Quality"
            value={v("quality")}
            options={[
              [1280, "720p"],
              [1920, "1080p"],
              [3840, "4K"],
            ]}
            onChange={(quality) => update({ quality })}
          />
        </div>
        {desktop && (
          <>
            <div className="pref-row">
              <span>
                <strong>Camera bubble on screen</strong>
                <small>
                  Drag it anywhere. Where it sits is where it renders.
                </small>
              </span>
              <Choice<"off" | BubbleSize>
                label="Camera bubble"
                value={v("bubble") ? v("bubbleSize") : "off"}
                options={[
                  ["off", "Off"],
                  ["s", "S"],
                  ["m", "M"],
                  ["l", "L"],
                ]}
                onChange={(size) =>
                  update(
                    size === "off"
                      ? { bubble: false }
                      : { bubble: true, bubbleSize: size },
                  )
                }
              />
            </div>
            <div className="pref-row">
              <span>
                <strong>Auto-zoom into key moments</strong>
                <small>Zooms where you point. Every zoom is editable.</small>
              </span>
              <Choice
                label="Auto-zoom"
                value={v("autoZoom") ? "on" : "off"}
                options={[
                  ["on", "On"],
                  ["off", "Off"],
                ]}
                onChange={(o) => update({ autoZoom: o === "on" })}
              />
            </div>
            <div className="pref-row">
              <span>
                <strong>Hide Relay while recording</strong>
                <small>Floating controls and the menu bar stay with you.</small>
              </span>
              <Choice
                label="Hide Relay while recording"
                value={v("hideWindow") ? "on" : "off"}
                options={[
                  ["on", "Hide"],
                  ["off", "Keep visible"],
                ]}
                onChange={(o) => update({ hideWindow: o === "on" })}
              />
            </div>
          </>
        )}
        <div className="pref-row">
          <span>
            <strong>On-device transcription</strong>
            <small>
              {ai.status === "unsupported"
                ? "Needs an Apple Silicon Mac. You can still import captions."
                : ai.status === "complete"
                  ? "Ready. Transcripts and captions work offline."
                  : ai.status === "failed"
                    ? "Couldn’t download right now. Relay retries when you transcribe."
                    : "A one-time 40 MB download. Your audio never leaves this machine."}
            </small>
          </span>
          {ai.status === "unsupported" ? (
            <span className="permission-state soft">Not available</span>
          ) : ai.status === "complete" ? (
            <span className="permission-state">
              <Check size={14} /> Ready
            </span>
          ) : ai.status === "running" ? (
            <span
              className="ai-progress"
              role="progressbar"
              aria-label="Downloading the transcription model"
              aria-valuenow={ai.progress}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <LoaderCircle size={14} className="spin" />
              <i>
                <b style={{ width: `${Math.max(4, ai.progress)}%` }} />
              </i>
            </span>
          ) : (
            <button
              className="btn small"
              disabled={ai.status === "checking"}
              onClick={() => void prepare()}
            >
              <Download size={14} />{" "}
              {ai.status === "failed" ? "Try again" : "Download now"}
            </button>
          )}
        </div>
      </div>
      {desktop && (
        <div className="shortcut-card">
          <Keyboard size={17} />
          <span>
            <kbd>⌥⇧R</kbd> start / finish
          </span>
          <span>
            <kbd>⌥⇧P</kbd> pause
          </span>
          <span>
            <PenLine size={13} /> <kbd>⌥⇧D</kbd> draw
          </span>
          <span>
            <kbd>⌥⇧C</kbd> discard
          </span>
        </div>
      )}
      <Footer onBack={onBack}>
        <button className="btn primary big" onClick={onNext}>
          Looks good <ArrowRight size={16} />
        </button>
      </Footer>
    </div>
  );
}
