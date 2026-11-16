import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Captions,
  CaptionsOff,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { clock } from "./types";
import "./draft-player.css";

const SPEEDS = ["0.75", "1", "1.25", "1.5", "2"];

// The player people see when a video is shared with them: the same controls as the
// editor preview, plus speed, captions and full screen.
export function WatchPlayer({
  video,
  src,
  poster,
  duration,
  hasCaptions,
  label,
  onTime,
  onReady,
  children,
}: {
  video: RefObject<HTMLVideoElement | null>;
  src: string;
  poster?: string;
  duration: number;
  hasCaptions: boolean;
  label?: string;
  onTime: (t: number) => void;
  onReady?: (v: HTMLVideoElement) => void;
  children?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false),
    [t, setT] = useState(0),
    [length, setLength] = useState(duration),
    [muted, setMuted] = useState(false),
    [captions, setCaptionsState] = useState(() => {
      try {
        return localStorage.getItem("relay-captions") === "on";
      } catch {
        return false;
      }
    }),
    [full, setFull] = useState(false),
    [waiting, setWaiting] = useState(false),
    [failed, setFailed] = useState(false),
    // The frame takes the video's own shape, so nothing is cropped or boxed.
    [ratio, setRatio] = useState(16 / 9),
    [speed, setSpeed] = useState("1");
  const setCaptions = (on: boolean) => {
    setCaptionsState(on);
    try {
      localStorage.setItem("relay-captions", on ? "on" : "off");
    } catch {
      /* Private windows can refuse storage; the choice just isn't remembered. */
    }
  };
  const total = length || duration || 1;
  const toggle = () => {
    const v = video.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  };
  const seek = (to: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(total, to));
    setT(v.currentTime);
    onTime(v.currentTime);
  };
  const fullscreen = () => {
    const v = video.current as
      (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (box.current?.requestFullscreen)
      void box.current.requestFullscreen().catch(() => {});
    // iPhones can only make the video itself full screen.
    else v?.webkitEnterFullscreen?.();
  };
  useEffect(() => {
    const change = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", change);
    return () => document.removeEventListener("fullscreenchange", change);
  }, []);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const apply = () => {
      for (const track of Array.from(v.textTracks))
        track.mode = captions ? "showing" : "hidden";
    };
    apply();
    v.textTracks.addEventListener("addtrack", apply);
    return () => v.textTracks.removeEventListener("addtrack", apply);
  }, [captions, hasCaptions, video]);
  useEffect(() => {
    if (video.current) video.current.playbackRate = Number(speed);
  }, [speed, video]);
  return (
    <div
      className={`draft-player watch-player ${full ? "is-full" : ""}`}
      ref={box}
      onKeyDown={(e) => {
        const el = e.target as HTMLElement;
        const control = /^(INPUT|SELECT|BUTTON|TEXTAREA)$/.test(el.tagName),
          field = /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName);
        if ((e.key === " " || e.key === "k") && !control) {
          e.preventDefault();
          toggle();
        } else if (e.key === "f" && el.tagName !== "SELECT") fullscreen();
        else if (e.key === "m" && el.tagName !== "SELECT") setMuted((m) => !m);
        else if (e.key === "ArrowRight" && !field) seek(t + 5);
        else if (e.key === "ArrowLeft" && !field) seek(t - 5);
      }}
    >
      <div
        className="video-player"
        style={{ aspectRatio: String(ratio) }}
        onClick={toggle}
      >
        <video
          ref={video}
          aria-label={label}
          src={src}
          poster={poster}
          preload="auto"
          muted={muted}
          playsInline
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => {
            setWaiting(false);
            setFailed(false);
          }}
          onCanPlay={() => setWaiting(false)}
          onError={(e) => {
            // Playback can fall back to another source; only report it if that fails too.
            const v = e.currentTarget;
            setTimeout(() => {
              if (v.error && v.readyState === 0) setFailed(true);
            }, 2500);
          }}
          onTimeUpdate={(e) => {
            setT(e.currentTarget.currentTime);
            onTime(e.currentTarget.currentTime);
          }}
          onDurationChange={(e) => {
            if (Number.isFinite(e.currentTarget.duration))
              setLength(e.currentTarget.duration);
          }}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight)
              setRatio(v.videoWidth / v.videoHeight);
            e.currentTarget.playbackRate = Number(speed);
            onReady?.(e.currentTarget);
          }}
        >
          {children}
        </video>
        {failed ? (
          <div className="watch-state" role="alert">
            <strong>This video couldn’t load.</strong>
            <button
              className="btn"
              onClick={(e) => {
                e.stopPropagation();
                setFailed(false);
                video.current?.load();
              }}
            >
              Try again
            </button>
          </div>
        ) : waiting && playing ? (
          <span className="draft-play watch-wait" role="status">
            <LoaderCircle size={30} className="spin" />
            <span className="sr-only">Loading</span>
          </span>
        ) : (
          !playing && (
            <span className="draft-play" aria-hidden="true">
              <Play size={30} fill="currentColor" />
            </span>
          )
        )}
      </div>
      <div className="draft-controls">
        <button
          className="icon-button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={toggle}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="draft-time">
          {clock(t)} <span>/ {clock(total)}</span>
        </span>
        <div className="draft-scrub">
          <input
            type="range"
            aria-label="Position in video"
            aria-valuetext={`${clock(t)} of ${clock(total)}`}
            min={0}
            max={total}
            step={0.1}
            value={Math.min(t, total)}
            onChange={(e) => seek(+e.target.value)}
            onKeyDown={(e) => {
              const by =
                e.key === "ArrowRight"
                  ? 5
                  : e.key === "ArrowLeft"
                    ? -5
                    : e.key === "PageUp"
                      ? total / 10
                      : e.key === "PageDown"
                        ? -total / 10
                        : 0;
              if (!by) return;
              e.preventDefault();
              e.stopPropagation();
              seek(t + by);
            }}
            style={{ ["--played" as string]: `${(t / total) * 100}%` }}
          />
        </div>
        <select
          className="watch-speed"
          aria-label="Playback speed"
          value={speed}
          onChange={(e) => setSpeed(e.target.value)}
        >
          {SPEEDS.map((x) => (
            <option key={x} value={x}>
              {x}×
            </option>
          ))}
        </select>
        {hasCaptions && (
          <button
            className="icon-button"
            aria-label="Captions"
            aria-pressed={captions}
            onClick={() => setCaptions(!captions)}
          >
            {captions ? <Captions size={18} /> : <CaptionsOff size={18} />}
          </button>
        )}
        <button
          className="icon-button"
          aria-label="Mute"
          title={muted ? "Turn sound on" : "Mute"}
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <button
          className="icon-button"
          aria-label={full ? "Leave full screen" : "Full screen"}
          onClick={fullscreen}
        >
          {full ? <Minimize size={18} /> : <Maximize size={18} />}
        </button>
      </div>
    </div>
  );
}
