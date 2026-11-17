export interface Comment {
  id: string;
  author: string;
  body: string;
  time: number;
  created: string;
  parentId?: string | null;
  resolved?: number | boolean;
  mentions?: string;
}
export interface Clip {
  id: string;
  title: string;
  description: string;
  duration: number;
  size: number;
  mime: string;
  thumbnail: string | null;
  created: string;
  starred: boolean;
  folder: string;
  token: string | null;
  views: number;
  revision?: number;
  streamReady?: boolean;
  project?: Project;
  transcript?: Word[];
  outline?: Outline;
  shareConfig?: ShareConfig;
  downloadAllowed?: boolean;
  author?: string;
  // The link on a connected server, and which revision of the video it plays.
  cloud?: { url: string; revision: number; at: string };
  // Whether the share page shows "Made with Relay".
  credit?: boolean;
  cta?: { label: string; url: string };
  comments: Comment[];
  reactions: { emoji: string; count: number }[];
}
export type Mode = "screen-camera" | "screen" | "camera";
export type BubbleSize = "s" | "m" | "l";
export interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
}
// What the Mac app is doing about its own updates (desktop/updates.cjs).
export interface DesktopUpdateState {
  // "auto" installs updates itself, "manual" can only point to the download
  // page, "none" is a copy run from source.
  mode: "auto" | "manual" | "none";
  // It would update itself if it were in the Applications folder.
  misplaced: boolean;
  automatic: boolean;
  version: string;
  status:
    | "idle"
    | "checking"
    | "current"
    | "downloading"
    | "preparing"
    | "ready"
    | "failed";
  latest?: string;
  percent?: number;
}
declare global {
  interface Window {
    relayDesktop?: {
      platform: string;
      sources: () => Promise<DesktopSource[]>;
      selectSource: (id: string) => Promise<void>;
      onRecord: (fn: () => void) => () => void;
      captureState?: (state: {
        active: boolean;
        paused: boolean;
        seconds: number;
        notes: string;
      }) => void;
      onControl?: (fn: (action: string) => void) => () => void;
      onPointer?: (fn: (point: { x: number; y: number }) => void) => () => void;
      selectRegion?: (
        sourceId: string,
      ) => Promise<{ x: number; y: number; w: number; h: number } | null>;
      permissionStatus?: () => Promise<{
        screen: string;
        camera: string;
        microphone: string;
        systemAudio: boolean;
      }>;
      notify?: (message: string) => void;
      setTheme?: (theme: "system" | "light" | "dark") => Promise<void>;
      checkForUpdates?: () => Promise<{ status: string; url?: string }>;
      updateState?: () => Promise<DesktopUpdateState>;
      setAutomaticUpdates?: (on: boolean) => Promise<DesktopUpdateState>;
      restartToUpdate?: () => Promise<{ ok: boolean; status: string }>;
      onUpdateState?: (fn: (state: DesktopUpdateState) => void) => () => void;
      info?: () => Promise<{
        version: string;
        packaged: boolean;
        platform: string;
        osRelease: string;
        stablePort: boolean;
      }>;
      requestPermission?: (
        kind: "camera" | "microphone" | "screen",
      ) => Promise<string>;
      openPermissionSettings?: (
        kind: "camera" | "microphone" | "screen" | "audio",
      ) => Promise<boolean>;
      relaunch?: () => Promise<void>;
      // Clears a stale Screen Recording grant and reopens Relay so macOS asks again.
      resetScreenPermission?: () => Promise<boolean>;
      prepareRecording?: (options: {
        screen: boolean;
        hideWindow: boolean;
        countdown: number;
        bubble: boolean;
        bubbleSize: BubbleSize;
        cameraId: string;
        filter?: string;
        background?: string;
      }) => Promise<{ cancelled: boolean }>;
      cameraLayout?: () => Promise<Partial<Project["layout"]["camera"]> | null>;
    };
  }
}
export const clock = (value: number) => {
  const n = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
export const bytes = (n: number) =>
  n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${(n / 1e6).toFixed(1)} MB`;
export async function api<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  // A proxy or crash can answer with a non-JSON page; keep the message readable.
  const data = await response.json().catch(() => ({
    error: response.ok
      ? "Relay sent an unreadable response."
      : `Request failed (${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`,
  }));
  if (!response.ok)
    throw Object.assign(
      new Error(data.error || "Could not complete that request."),
      data,
      { status: response.status },
    );
  return data;
}
export const mediaURL = (clip: Clip, token?: string) =>
  token ? `/api/share/${token}/media` : `/api/media/${clip.id}`;

export interface Word {
  text: string;
  start: number;
  end: number;
  sourceId?: string;
  sourceStart?: number;
  sourceEnd?: number;
  granularity?: "word" | "segment";
}
export interface Project {
  version: 1;
  segments: { sourceId: string; start: number; end: number }[];
  layout: {
    width: number;
    height: number;
    padding: number;
    background: string;
    wallpaper?: string;
    radius?: number;
    shadow?: number;
    preset?: "pip" | "side" | "screen" | "camera";
    captionStyle?: "clean" | "bold" | "box" | "highlight";
    camera: {
      visible: boolean;
      x: number;
      y: number;
      size: number;
      shape: "circle" | "square" | "portrait";
    };
    audio: {
      microphone: number;
      system: number;
      normalize: boolean;
      denoise: boolean;
    };
    captions: boolean;
  };
  overlays: {
    id: string;
    type:
      | "text"
      | "box"
      | "arrow"
      | "blur"
      | "zoom"
      | "cursor"
      | "title"
      | "lowerthird"
      | "chapter";
    sub?: string;
    start: number;
    end: number;
    x: number;
    y: number;
    w: number;
    h: number;
    scale: number;
    text: string;
    color: string;
    auto?: boolean;
    motion?: "smooth" | "quick" | "cut";
    textStyle?: "label" | "outline" | "plain";
    textSize?: number;
    animation?: "none" | "fade";
  }[];
  scenes?: {
    id: string;
    start: number;
    end: number;
    preset: "pip" | "side" | "screen" | "camera";
  }[];
  cta: { label: string; url: string };
}
export interface Job {
  id: string;
  type?: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: number;
  result?: { videoId?: string; [key: string]: unknown };
  error?: string;
}
export interface ProjectState {
  project: Project;
  published?: Project;
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  sources: {
    role: string;
    mime: string;
    duration: number;
    info: Record<string, unknown>;
  }[];
  sourceDuration: number;
}
export interface Outline {
  summary?: string;
  title?: string;
  chapters?: { time: number; title: string }[];
  actionItems?: string[];
  provider?: string;
}
export interface ShareConfig {
  access: "link" | "workspace" | "invited";
  download: boolean;
  expiresAt?: string | null;
  hasPassword?: boolean;
  invitedEmails?: string[];
  version?: number;
}
export interface Member {
  id: string;
  name: string;
  email: string;
  role: "owner" | "editor" | "viewer";
}
export interface Analytics {
  views: number;
  sessions: number;
  averageCompletion: number;
  watchSeconds: number;
  ctaClicks: number;
  bins: number[];
}
