import { api, type Mode, type BubbleSize } from "./types";

// Studio preferences are stored with the library on the server, so they survive
// origin changes (desktop port, reinstall) that would reset browser storage.
export interface Preferences {
  onboarded?: boolean;
  onboardingStep?: string;
  afterRecording?: "copy-link" | "open-editor";
  countdown?: 0 | 3 | 5;
  hideWindow?: boolean;
  bubble?: boolean;
  bubbleSize?: BubbleSize;
  quality?: 1280 | 1920 | 3840;
  mode?: Mode;
  microphoneId?: string;
  cameraId?: string;
  systemAudio?: boolean;
}
export const defaults: Required<
  Omit<Preferences, "onboardingStep" | "microphoneId" | "cameraId" | "mode">
> = {
  onboarded: false,
  afterRecording: "copy-link",
  countdown: 3,
  hideWindow: true,
  bubble: true,
  bubbleSize: "m",
  quality: 1920,
  systemAudio: true,
};
let cache: Preferences | null = null;
let loading: Promise<Preferences> | null = null;
const listeners = new Set<(p: Preferences) => void>();
export function loadPreferences(force = false): Promise<Preferences> {
  if (cache && !force) return Promise.resolve(cache);
  return (loading ??= api<Preferences>("/api/preferences")
    .then((p) => (cache = p))
    .catch(() => (cache = {}))
    .finally(() => (loading = null)));
}
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
  listeners.forEach((fn) => fn(cache!));
  try {
    cache = await api<Preferences>("/api/preferences", {
      method: "PUT",
      body: JSON.stringify(next),
    });
  } catch {
    /* Keep the optimistic value; it will be written on the next change. */
  }
  listeners.forEach((fn) => fn(cache!));
  return cache!;
}
export function onPreferences(fn: (p: Preferences) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
