import { radio } from "./Modal";
import { useEffect, useRef, useState } from "react";
import { Ban, Camera, ImagePlus, LoaderCircle } from "lucide-react";
import {
  BACKGROUNDS,
  FILTERS,
  createCameraPipeline,
  customBackground,
  filterCSS,
  saveCustomBackground,
  type CameraFilter,
  type CameraLook,
  type CameraPipeline,
} from "./cameraEffects";
import { openInput } from "./media";
import "./camera-look.css";

// Live preview plus filter and background choices. The preview runs the same
// pipeline used while recording, so what you see is what gets recorded.
export function CameraLookPicker({
  cameraId,
  look,
  onChange,
  size = 168,
}: {
  cameraId: string;
  look: CameraLook;
  onChange: (look: CameraLook) => void;
  size?: number;
}) {
  const video = useRef<HTMLVideoElement>(null),
    pipeline = useRef<CameraPipeline | null>(null),
    upload = useRef<HTMLInputElement>(null);
  const latest = useRef(look);
  latest.current = look;
  const [error, setError] = useState(""),
    [backgroundError, setBackgroundError] = useState(""),
    [preparing, setPreparing] = useState(false),
    [custom, setCustom] = useState(() => customBackground());
  // Shows a spinner while a background gets ready, and says so if it can't start.
  const prepare = (p: CameraPipeline) => {
    const ready = p.ready,
      current = () => pipeline.current === p && p.ready === ready;
    setBackgroundError("");
    setPreparing(latest.current.background !== "none");
    void ready
      .catch(
        () =>
          current() && setBackgroundError("That background couldn’t start."),
      )
      .finally(() => current() && setPreparing(false));
  };
  useEffect(() => {
    let raw: MediaStream | undefined,
      cancelled = false;
    setError("");
    if (!navigator.mediaDevices) return;
    // The parent clears a remembered camera that has gone; meanwhile the preview
    // falls back to the default one.
    void openInput("camera", cameraId)
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        raw = s;
        const p = await createCameraPipeline(s, latest.current);
        if (cancelled) return p.stop();
        pipeline.current = p;
        p.setLook(latest.current);
        prepare(p);
        if (video.current) video.current.srcObject = p.stream;
      })
      .catch((e) =>
        setError(
          e?.name === "NotAllowedError"
            ? "Camera access is off. Allow it for this site in your browser’s address bar."
            : "No camera found.",
        ),
      );
    return () => {
      cancelled = true;
      pipeline.current?.stop();
      pipeline.current = null;
      raw?.getTracks().forEach((t) => t.stop());
    };
    // The pipeline is rebuilt only when the device changes; looks update live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId]);
  useEffect(() => {
    const p = pipeline.current;
    if (!p) return;
    p.setLook(latest.current);
    prepare(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [look.filter, look.background]);
  return (
    <div className="camera-look">
      <div
        className="look-preview"
        style={{ width: size, height: size }}
        aria-label="Camera preview"
      >
        <video ref={video} autoPlay muted playsInline />
        {(error || backgroundError) && (
          <span className="look-empty" role="alert">
            <Camera size={24} />
            <small>{error || backgroundError}</small>
          </span>
        )}
        {preparing && !error && (
          <span className="look-busy">
            <LoaderCircle size={16} className="spin" />
          </span>
        )}
      </div>
      <div className="look-options">
        <span className="look-label">Filter</span>
        <div
          className="look-row filters"
          role="radiogroup"
          aria-label="Camera filter"
        >
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.id}
              {...radio(look.filter === f.id)}
              className={`look-chip ${look.filter === f.id ? "selected" : ""}`}
              onClick={() =>
                onChange({ ...look, filter: f.id as CameraFilter })
              }
            >
              <i
                className="filter-swatch"
                style={{ filter: filterCSS(f.id) }}
                aria-hidden="true"
              />
              {f.label}
            </button>
          ))}
        </div>
        <span className="look-label">Background</span>
        <div
          className="look-row"
          role="radiogroup"
          aria-label="Camera background"
        >
          {BACKGROUNDS.map((b) => (
            <button
              type="button"
              key={b.id}
              {...radio(look.background === b.id)}
              aria-label={b.label}
              title={b.label}
              className={`bg-chip ${look.background === b.id ? "selected" : ""}`}
              style={b.swatch ? { background: b.swatch } : undefined}
              onClick={() => onChange({ ...look, background: b.id })}
            >
              {b.id === "none" && <Ban size={15} />}
              {b.id === "blur" && <span className="blur-swatch" />}
            </button>
          ))}
          {custom && (
            <button
              type="button"
              {...radio(look.background === "custom")}
              aria-label="Your picture"
              title="Your picture"
              className={`bg-chip ${look.background === "custom" ? "selected" : ""}`}
              style={{
                backgroundImage: `url(${custom})`,
                backgroundSize: "cover",
              }}
              onClick={() => onChange({ ...look, background: "custom" })}
            />
          )}
          <button
            type="button"
            className="bg-chip add"
            aria-label="Use your own picture"
            title="Use your own picture"
            onClick={() => upload.current?.click()}
          >
            <ImagePlus size={15} />
          </button>
          <input
            ref={upload}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                setCustom(await saveCustomBackground(file));
                // Repaint even if "custom" was already selected.
                onChange({ ...look, background: "custom" });
                pipeline.current?.setLook({ ...look, background: "custom" });
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
