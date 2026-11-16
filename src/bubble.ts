// The floating camera bubble in the Mac app. It runs the same look pipeline as
// the recorder, so filters and backgrounds match the recording.
import {
  createCameraPipeline,
  type CameraFilter,
  type CameraPipeline,
} from "./cameraEffects";

declare global {
  interface Window {
    relayOverlay?: {
      onBubbleConfig: (
        fn: (config: {
          deviceId?: string;
          size?: string;
          filter?: string;
          background?: string;
        }) => void,
      ) => void;
      bubbleSize: (size: string) => void;
      hideBubble: () => void;
    };
  }
}
const video = document.getElementById("video") as HTMLVideoElement;
const empty = document.getElementById("empty")!;
let device: string | undefined,
  raw: MediaStream | undefined,
  pipeline: CameraPipeline | undefined,
  look = { filter: "none" as CameraFilter, background: "none" };

function release() {
  pipeline?.stop();
  raw?.getTracks().forEach((t) => t.stop());
  pipeline = raw = undefined;
}
async function open(deviceId: string) {
  if (device === deviceId && pipeline) return;
  device = deviceId;
  release();
  try {
    raw = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 640 },
        height: { ideal: 640 },
      },
      audio: false,
    });
    pipeline = await createCameraPipeline(raw, look, 24);
    video.srcObject = pipeline.stream;
    empty.hidden = true;
  } catch {
    empty.hidden = false;
  }
}
const mark = (size: string) => {
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-size]"))
    b.setAttribute("aria-pressed", String(b.dataset.size === size));
};
window.relayOverlay?.onBubbleConfig((config) => {
  if (config.size) mark(config.size);
  if (config.filter || config.background) {
    look = {
      filter: (config.filter as CameraFilter) || look.filter,
      background: config.background || look.background,
    };
    pipeline?.setLook(look);
  }
  if (typeof config.deviceId === "string") void open(config.deviceId);
});
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-size]"))
  b.onclick = () => window.relayOverlay?.bubbleSize(b.dataset.size!);
document.getElementById("hide")!.onclick = () => {
  release();
  window.relayOverlay?.hideBubble();
};
addEventListener("beforeunload", release);
