import { useEffect, useState } from "react";
import { clock } from "./types";

export function FrameStrip({
  src,
  duration,
  start,
  end,
  poster,
  onSeek,
}: {
  src: string;
  duration: number;
  start: number;
  end: number;
  poster: string | null;
  onSeek: (time: number) => void;
}) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    const wait = (event: "loadedmetadata" | "seeked") =>
      new Promise<void>((resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          video.removeEventListener(event, done);
          video.removeEventListener("error", error);
          resolve();
        };
        const error = () => {
          clearTimeout(timer);
          video.removeEventListener(event, done);
          reject(new Error("Frame preview unavailable"));
        };
        const timer = setTimeout(error, 8000);
        video.addEventListener(event, done, { once: true });
        video.addEventListener("error", error, { once: true });
      });
    (async () => {
      try {
        const metadata = wait("loadedmetadata");
        video.src = src;
        await metadata;
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 90;
        const ctx = canvas.getContext("2d")!;
        const next: string[] = [];
        for (let i = 0; i < 10 && !cancelled; i++) {
          const time = Math.min(duration - 0.01, ((i + 0.5) / 10) * duration);
          const ready = wait("seeked");
          video.currentTime = Math.max(0.001, time);
          await ready;
          if (cancelled) break;
          ctx.drawImage(video, 0, 0, 160, 90);
          next.push(canvas.toDataURL("image/jpeg", 0.65));
          setFrames([...next]);
        }
      } catch {
        /* The saved poster remains a usable fallback if decoding is interrupted. */
      }
    })();
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
    };
  }, [src, duration]);
  return (
    <div className="frame-strip" aria-label="Video frames">
      {Array.from({ length: 10 }, (_, i) => (
        <button
          key={i}
          aria-label={`Seek to ${clock(((i + 0.5) / 10) * duration)}`}
          onClick={() => onSeek(((i + 0.5) / 10) * duration)}
        >
          {frames[i] || poster ? (
            <img alt="" src={frames[i] || poster!} />
          ) : (
            <span />
          )}
          <small>{clock((i / 10) * duration)}</small>
        </button>
      ))}
      <div
        className="frame-shade"
        style={{ left: 0, width: `${(start / duration) * 100}%` }}
      />
      <div
        className="frame-shade"
        style={{ right: 0, width: `${(1 - end / duration) * 100}%` }}
      />
      <i
        className="range-marker"
        style={{ left: `${(start / duration) * 100}%` }}
      />
      <i
        className="range-marker"
        style={{ left: `${(end / duration) * 100}%` }}
      />
    </div>
  );
}
