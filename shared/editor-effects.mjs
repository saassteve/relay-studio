export const MAX_EFFECTS = 60;
export const ZOOM_MOTIONS = ["smooth", "quick", "cut"];
export const TEXT_STYLES = ["label", "outline", "plain"];
export const TEXT_ANIMATIONS = ["none", "fade"];
export const DEFAULT_TEXT_SIZE = 0.045;

export function zoomEase({ start, end, motion }) {
  if (motion === "cut") return 0;
  return Math.min(motion === "quick" ? 0.2 : 0.5, (end - start) / 3);
}

export function zoomAt(zooms, time) {
  let weight = 0,
    magnification = 0,
    x = 0,
    y = 0;
  for (const zoom of zooms) {
    if (time < zoom.start || time >= zoom.end) continue;
    const ease = zoomEase(zoom);
    const ramp = ease
      ? Math.min(1, (time - zoom.start) / ease, (zoom.end - time) / ease)
      : 1;
    const amount = ramp * ramp * (3 - 2 * ramp);
    const depth = amount * (zoom.scale - 1);
    weight += amount;
    magnification += depth;
    x += zoom.x * depth;
    y += zoom.y * depth;
  }
  return {
    scale: 1 + magnification / Math.max(1, weight),
    x: magnification > 0.0001 ? x / magnification : 0.5,
    y: magnification > 0.0001 ? y / magnification : 0.5,
  };
}

export function textFade({ start, end, animation }) {
  return animation === "fade" ? Math.min(0.25, (end - start) / 3) : 0;
}
