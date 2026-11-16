import { useEffect, type RefObject } from "react";
import Hls from "hls.js";
import { type Clip, mediaURL } from "./types";
export function usePlayback(
  ref: RefObject<HTMLVideoElement | null>,
  clip: Clip,
  token?: string,
) {
  useEffect(() => {
    const video = ref.current;
    if (!video || !clip.streamReady) return;
    const src = token
      ? `/api/share/${token}/stream/master.m3u8`
      : `/api/videos/${clip.id}/stream/master.m3u8`;
    // Prefer hls.js wherever Media Source Extensions exist. Chrome's newer built-in
    // HLS can stall early on these renditions; native HLS is kept for browsers
    // without MSE (older iPhones).
    const useHls = Hls.isSupported();
    if (!useHls && !video.canPlayType("application/vnd.apple.mpegurl")) return;
    const hls = useHls ? new Hls({ maxBufferLength: 20 }) : null;
    let fellBack = false,
      last = -1,
      stuck = 0;
    // If adaptive playback stops advancing, continue from the same point on the MP4.
    const fallback = () => {
      if (fellBack) return;
      fellBack = true;
      clearInterval(watchdog);
      const at = video.currentTime,
        playing = !video.paused;
      hls?.destroy();
      video.src = mediaURL(clip, token);
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = at;
          if (playing) void video.play().catch(() => {});
        },
        { once: true },
      );
    };
    const watchdog = setInterval(() => {
      if (video.paused || video.ended || video.seeking) {
        stuck = 0;
        last = video.currentTime;
        return;
      }
      stuck = video.currentTime === last ? stuck + 1 : 0;
      last = video.currentTime;
      if (stuck >= 3) fallback();
    }, 1000);
    if (hls) {
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) fallback();
      });
    } else {
      video.src = src;
      video.addEventListener("error", fallback, { once: true });
    }
    return () => {
      clearInterval(watchdog);
      video.removeEventListener("error", fallback);
      if (!fellBack) hls?.destroy();
    };
  }, [clip.id, clip.revision, clip.streamReady, token]);
  useEffect(() => {
    if (!token) return;
    const video = ref.current;
    if (!video) return;
    const key = `relay-watch-${token}`;
    let sessionId = sessionStorage.getItem(key);
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      sessionStorage.setItem(key, sessionId);
    }
    let last = video.currentTime,
      observed = last,
      wall = performance.now(),
      playing = false;
    const send = (event: string, from = last, to = observed) => {
      if (!Number.isFinite(from) || !Number.isFinite(to)) return;
      void fetch(`/api/share/${token}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, event, from, to }),
        keepalive: true,
      }).catch(() => {});
    };
    const flush = (event = "progress") => {
      if (observed > last + 0.05) send(event);
      last = observed;
    };
    const sample = () => {
      const now = performance.now(),
        position = video.currentTime,
        elapsed = (now - wall) / 1000;
      const delta = position - observed;
      if (
        playing &&
        !video.seeking &&
        delta >= 0 &&
        delta <= elapsed * video.playbackRate + 0.75
      ) {
        observed = position;
        if (observed - last >= 4) flush();
      } else {
        flush();
        last = observed = position;
      }
      wall = now;
    };
    const play = () => {
      last = observed = video.currentTime;
      wall = performance.now();
      playing = true;
      send("play", last, last);
    };
    const pause = () => {
      sample();
      flush();
      playing = false;
    };
    const seeking = () => {
      flush();
      last = observed = video.currentTime;
      wall = performance.now();
    };
    const ended = () => {
      sample();
      flush("ended");
      playing = false;
    };
    const timer = setInterval(sample, 250);
    video.addEventListener("play", play);
    video.addEventListener("pause", pause);
    video.addEventListener("seeking", seeking);
    video.addEventListener("seeked", seeking);
    video.addEventListener("ended", ended);
    const unload = () => {
      sample();
      flush();
    };
    addEventListener("pagehide", unload);
    return () => {
      flush();
      clearInterval(timer);
      video.removeEventListener("play", play);
      video.removeEventListener("pause", pause);
      video.removeEventListener("seeking", seeking);
      video.removeEventListener("seeked", seeking);
      video.removeEventListener("ended", ended);
      removeEventListener("pagehide", unload);
    };
  }, [clip.id, token]);
}
export function trackCTA(token: string) {
  const sessionId =
    sessionStorage.getItem(`relay-watch-${token}`) || crypto.randomUUID();
  void fetch(`/api/share/${token}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, event: "cta" }),
  }).catch(() => {});
}
