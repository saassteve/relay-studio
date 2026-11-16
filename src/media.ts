import type { Mode } from "./types";
import { ticker } from "./ticker";
import {
  createCameraPipeline,
  isPlain,
  type CameraLook,
  type CameraPipeline,
} from "./cameraEffects";
export interface CaptureOptions {
  microphoneId?: string;
  cameraId?: string;
  systemAudio?: boolean;
  region?: { x: number; y: number; w: number; h: number };
  frameRate?: number;
  look?: CameraLook;
}
export type CaptureSession = {
  stream: MediaStream;
  tracks: Partial<
    Record<"screen" | "camera" | "microphone" | "system", MediaStream>
  >;
  level: () => number;
  cleanup: () => void;
};
const ready = async (stream: MediaStream) => {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  await v.play();
  return v;
};
export async function acquireCapture(
  mode: Mode,
  mic: boolean,
  quality: number,
  options: CaptureOptions = {},
): Promise<CaptureSession> {
  const owned: MediaStream[] = [];
  let context: AudioContext | undefined;
  let frame = 0,
    stopRegion: () => void = () => {};
  let regionStream: MediaStream | undefined;
  let analyser: AnalyserNode | undefined;
  let canvasStream: MediaStream | undefined;
  let look: CameraPipeline | undefined;
  const cleanup = () => {
    look?.stop();
    cancelAnimationFrame(frame);
    stopRegion();
    regionStream?.getTracks().forEach((t) => t.stop());
    owned.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    canvasStream?.getTracks().forEach((t) => t.stop());
    if (context && context.state !== "closed")
      void context.close().catch(() => {});
  };
  try {
    if (!navigator.mediaDevices)
      throw new Error(
        "Recording needs HTTPS or localhost. Open Relay in a secure browser.",
      );
    let screen: MediaStream | undefined,
      camera: MediaStream | undefined,
      microphone: MediaStream | undefined;
    if (mode !== "camera") {
      screen = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: quality },
          height: { ideal: (quality * 9) / 16 },
          frameRate: options.frameRate || 30,
        },
        audio: options.systemAudio !== false,
      });
      owned.push(screen);
    }
    if (mode !== "screen") {
      camera = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(options.cameraId
            ? { deviceId: { exact: options.cameraId } }
            : {}),
          width: { ideal: mode === "camera" ? quality : 1280 },
          height: { ideal: mode === "camera" ? (quality * 9) / 16 : 720 },
        },
        audio: false,
      });
      owned.push(camera);
      // Filters and backgrounds are applied live, so the recorded camera track
      // looks exactly like the preview.
      if (options.look && !isPlain(options.look)) {
        look = await createCameraPipeline(camera, options.look);
        await look.ready;
        camera = look.stream;
      }
    }
    if (mic) {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(options.microphoneId
            ? { deviceId: { exact: options.microphoneId } }
            : {}),
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      owned.push(microphone);
    }
    const originalScreen = screen;
    if (
      options.systemAudio &&
      screen?.getAudioTracks().some((t) => t.readyState === "ended")
    )
      throw new Error(
        "System audio permission was denied. Enable System Audio Recording in macOS Privacy settings, or turn off system audio and try again.",
      );
    if (screen && options.region) {
      const source = await ready(screen),
        r = options.region,
        canvas = document.createElement("canvas");
      const sw = Math.max(2, Math.round((source.videoWidth * r.w) / 2) * 2),
        sh = Math.max(2, Math.round((source.videoHeight * r.h) / 2) * 2);
      canvas.width = Math.min(quality, sw);
      canvas.height = Math.round((canvas.width * sh) / sw / 2) * 2;
      const ctx = canvas.getContext("2d")!;
      // The cropped region is a recorded track, so it is drawn on a steady timer rather than
      // animation frames, which stop while Relay's window is hidden during capture.
      const draw = () => {
        ctx.drawImage(
          source,
          source.videoWidth * r.x,
          source.videoHeight * r.y,
          sw,
          sh,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      };
      draw();
      stopRegion = ticker(draw, options.frameRate || 30);
      regionStream = canvas.captureStream(options.frameRate || 30);
      screen = new MediaStream([
        ...regionStream.getVideoTracks(),
        ...screen.getAudioTracks(),
      ]);
    }
    const tracks: CaptureSession["tracks"] = {};
    if (screen) tracks.screen = new MediaStream(screen.getVideoTracks());
    if (camera) tracks.camera = new MediaStream(camera.getVideoTracks());
    if (microphone?.getAudioTracks().length)
      tracks.microphone = new MediaStream(microphone.getAudioTracks());
    if (screen?.getAudioTracks().length)
      tracks.system = new MediaStream(screen.getAudioTracks());
    let videoTracks: MediaStreamTrack[];
    if (screen && camera) {
      const sv = await ready(screen),
        cv = await ready(camera);
      const canvas = document.createElement("canvas");
      // Preview only (tracks are recorded separately), so keep it light.
      canvas.width = Math.min(960, sv.videoWidth || 960);
      canvas.height = Math.round(
        (canvas.width * (sv.videoHeight || 720)) / (sv.videoWidth || 1280),
      );
      const ctx = canvas.getContext("2d")!;
      const draw = () => {
        ctx.drawImage(sv, 0, 0, canvas.width, canvas.height);
        const r = Math.round(canvas.width * 0.09),
          x = r + canvas.width * 0.025,
          y = canvas.height - r - canvas.width * 0.025;
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r + 4, 0, Math.PI * 2);
        ctx.fillStyle = "#d6f475";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        const side = Math.min(cv.videoWidth, cv.videoHeight);
        ctx.translate(x, y);
        ctx.scale(-1, 1);
        ctx.drawImage(
          cv,
          (cv.videoWidth - side) / 2,
          (cv.videoHeight - side) / 2,
          side,
          side,
          -r,
          -r,
          r * 2,
          r * 2,
        );
        ctx.restore();
        frame = requestAnimationFrame(draw);
      };
      draw();
      canvasStream = canvas.captureStream(30);
      videoTracks = canvasStream.getVideoTracks();
    } else videoTracks = (screen || camera)!.getVideoTracks();
    const audio = owned.flatMap((s) => s.getAudioTracks());
    let audioTracks: MediaStreamTrack[] = [];
    if (audio.length) {
      context = new AudioContext();
      await context.resume();
      const destination = context.createMediaStreamDestination();
      if (microphone) {
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(microphone).connect(analyser);
      }
      for (const track of audio)
        context
          .createMediaStreamSource(new MediaStream([track]))
          .connect(destination);
      audioTracks = destination.stream.getAudioTracks();
    }
    const stream = new MediaStream([...videoTracks, ...audioTracks]);
    if (originalScreen)
      originalScreen.getVideoTracks()[0].addEventListener(
        "ended",
        () => {
          tracks.screen
            ?.getVideoTracks()
            .forEach((t) => t.dispatchEvent(new Event("ended")));
          stream.getVideoTracks().forEach((t) => {
            t.stop();
            t.dispatchEvent(new Event("ended"));
          });
        },
        { once: true },
      );
    return {
      stream,
      tracks,
      cleanup,
      level: () => {
        if (!analyser) return 0;
        const data = new Uint8Array(analyser.fftSize);
        analyser.getByteTimeDomainData(data);
        return Math.min(
          1,
          Math.sqrt(
            data.reduce((n, v) => n + ((v - 128) / 128) ** 2, 0) / data.length,
          ) * 4,
        );
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
export async function inspectVideo(
  blob: Blob,
  fallbackDuration = 0,
): Promise<{ duration: number; thumbnail: string }> {
  const url = URL.createObjectURL(blob),
    video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.src = url;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error("This video could not be read. Try MP4 or WebM.")),
        15000,
      );
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(
          new Error("This video format could not be read. Try MP4 or WebM."),
        );
      };
    });
    let duration = Number.isFinite(video.duration)
      ? video.duration
      : fallbackDuration;
    if (!duration) {
      video.currentTime = 1e10;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        setTimeout(resolve, 1200);
      });
      duration = Number.isFinite(video.duration) ? video.duration : 0;
    }
    if (duration <= 0)
      throw new Error(
        "The video duration is unavailable. Please try another file.",
      );
    video.currentTime = Math.min(1, duration / 3);
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      setTimeout(resolve, 1000);
    });
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    canvas.getContext("2d")?.drawImage(video, 0, 0, 640, 360);
    return { duration, thumbnail: canvas.toDataURL("image/jpeg", 0.8) };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
export async function createDemo(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d")!;
  const stream = canvas.captureStream(24);
  const mime = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/mp4",
  ].find((m) => MediaRecorder.isTypeSupported(m));
  const recorder = new MediaRecorder(
      stream,
      mime ? { mimeType: mime } : undefined,
    ),
    chunks: Blob[] = [];
  return new Promise((resolve, reject) => {
    let frame = 0,
      regionFrame = 0;
    let regionStream: MediaStream | undefined;
    let analyser: AnalyserNode | undefined;
    const start = performance.now();
    const draw = () => {
      const t = (performance.now() - start) / 1000;
      ctx.fillStyle = "#173e32";
      ctx.fillRect(0, 0, 1280, 720);
      ctx.fillStyle = "#d6f475";
      ctx.beginPath();
      ctx.arc(1050, 340, 190 + Math.sin(t) * 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#173e32";
      ctx.beginPath();
      ctx.moveTo(1000, 260);
      ctx.lineTo(1140, 340);
      ctx.lineTo(1000, 420);
      ctx.fill();
      ctx.fillStyle = "#d6f475";
      ctx.font = "24px system-ui";
      ctx.fillText("YOUR FIRST RELAY", 80, 170);
      ctx.fillStyle = "#fffef8";
      ctx.font = "bold 76px system-ui";
      ctx.fillText("A little less meeting.", 80, 290);
      ctx.fillText("A lot more doing.", 80, 390);
      ctx.font = "24px system-ui";
      ctx.fillStyle = "#c2d0c6";
      ctx.fillText("Record. Review. Pass it on.", 80, 470);
      ctx.fillStyle = "#d6f475";
      ctx.fillRect(80, 600, 1120 * Math.min(t / 6, 1), 5);
      frame = requestAnimationFrame(draw);
    };
    draw();
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    recorder.onerror = () => reject(new Error("Could not generate the demo."));
    recorder.onstop = () => {
      cancelAnimationFrame(frame);
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType }));
    };
    recorder.start();
    setTimeout(() => recorder.stop(), 6000);
  });
}
