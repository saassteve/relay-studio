export const MAX_EFFECTS: number;
export const ZOOM_MOTIONS: readonly ["smooth", "quick", "cut"];
export const TEXT_STYLES: readonly ["label", "outline", "plain"];
export const TEXT_ANIMATIONS: readonly ["none", "fade"];
export const DEFAULT_TEXT_SIZE: number;

type Range = { start: number; end: number };
type Zoom = Range & {
  motion?: (typeof ZOOM_MOTIONS)[number];
  x: number;
  y: number;
  scale: number;
};
export function zoomEase(zoom: Range & Pick<Zoom, "motion">): number;
export function zoomAt(
  zooms: Zoom[],
  time: number,
): { scale: number; x: number; y: number };
export function textFade(
  text: Range & { animation?: (typeof TEXT_ANIMATIONS)[number] },
): number;
