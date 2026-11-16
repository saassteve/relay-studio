import { api, type Mode, type BubbleSize } from "./types";
import type { CameraFilter } from "./cameraEffects";

// Studio preferences are stored with the library on the server, so they survive
// origin changes (desktop port, reinstall) that would reset browser storage.
export interface Preferences {
  onboarded?: boolean;
  onboardingStep?: string;
  afterRecording?: "copy-link" | "open-editor";
  countdown?: 0 | 3 | 5;
  hideWindow?: boolean;
  // Single-key shortcuts such as R for a new recording.
  keyShortcuts?: boolean;
  bubble?: boolean;
  bubbleSize?: BubbleSize;
  quality?: 1280 | 1920 | 3840;
  mode?: Mode;
  // Device ids mean something only to the browser and address that saved them.
  // The recorder falls back to the default device when one is not recognised.
  microphoneId?: string;
  cameraId?: string;
  systemAudio?: boolean;
  autoZoom?: boolean;
  cameraFilter?: CameraFilter;
  cameraBackground?: string;
}
export const defaults: Required<
  Omit<Preferences, "onboardingStep" | "microphoneId" | "cameraId" | "mode">
> = {
  onboarded: false,
  afterRecording: "copy-link",
  countdown: 3,
  hideWindow: true,
  keyShortcuts: true,
  bubble: true,
  bubbleSize: "m",
  quality: 1920,
  systemAudio: true,
  autoZoom: true,
  cameraFilter: "none",
  cameraBackground: "none",
};
let cache: Preferences | null = null;
let loaded = false;
let loading: Promise<Preferences> | null = null;
// Changes not yet confirmed by the server; resent with the next save.
let unsaved: Record<string, unknown> = {};
let latestWrite = 0;
export function loadPreferences(force = false): Promise<Preferences> {
  if (cache && loaded && !force) return Promise.resolve(cache);
  return (loading ??= api<Preferences>("/api/preferences")
    .then((p) => {
      loaded = true;
      return (cache = { ...p, ...unsaved } as Preferences);
    })
    // A failed load keeps whatever we already knew.
    .catch(() => (cache ??= {}))
    .finally(() => (loading = null)));
}
export const preferencesLoaded = () => loaded;
export function cachedPreferences(): Preferences {
  return cache || {};
}
export function pref<K extends keyof typeof defaults>(
  key: K,
): (typeof defaults)[K] {
  return (cache?.[key] ?? defaults[key]) as (typeof defaults)[K];
}
export async function savePreferences(
  next: Partial<{ [K in keyof Preferences]: Preferences[K] | null }>,
): Promise<Preferences> {
  cache = { ...(cache || {}), ...next } as Preferences;
  unsaved = { ...unsaved, ...next };
  const write = ++latestWrite,
    sending = unsaved;
  try {
    const saved = await api<Preferences>("/api/preferences", {
      method: "PUT",
      body: JSON.stringify(sending),
    });
    for (const key of Object.keys(sending))
      if (unsaved[key] === sending[key]) delete unsaved[key];
    // An older response must not overwrite a newer choice.
    if (write === latestWrite) cache = { ...saved, ...unsaved } as Preferences;
  } catch {
    /* Kept in `unsaved`; it goes out with the next change. */
  }
  return cache!;
}
