// Captions and titles are rendered by libass from one generated .ass file:
// styled captions (including word-by-word highlight), title cards, lower thirds
// and chapter labels, each with its own entrance and exit.
import { captionCues } from "./project.mjs";

export const CAPTION_STYLES = ["clean", "bold", "box", "highlight"];
export const TITLE_TYPES = ["title", "lowerthird", "chapter"];

const LIME = "&H75F4D6&"; // #d6f475 as ASS BGR
const WHITE = "&HFFFFFF&";
const PINE = "&H323E17&"; // #173e32

const stamp = (t) => {
  const cs = Math.max(0, Math.round(t * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, "0")}:${String(Math.floor(cs / 100) % 60).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};
// Text from users and transcripts must not be read as ASS override codes.
const clean = (s) =>
  String(s ?? "")
    .replace(/[{}\\]/g, " ")
    .replace(/\s*\n+\s*/g, "\\N")
    .trim();
const hexToASS = (hex, fallback = LIME) => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  return m ? `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase() : fallback;
};
// A rounded rectangle as an ASS drawing.
function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  const k = r * 0.5523;
  const f = (n) => Math.round(n);
  return [
    `m ${f(x + r)} ${f(y)}`,
    `l ${f(x + w - r)} ${f(y)}`,
    `b ${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)}`,
    `l ${f(x + w)} ${f(y + h - r)}`,
    `b ${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}`,
    `l ${f(x + r)} ${f(y + h)}`,
    `b ${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)}`,
    `l ${f(x)} ${f(y + r)}`,
    `b ${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)}`,
  ].join(" ");
}
// Chinese, Japanese and Korean characters and emoji are about as wide as they are tall.
const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|\p{Extended_Pictographic}/u;
// Rough text width; the shapes behind text are padded to allow for the error.
const textWidth = (text, size, bold) =>
  [...String(text)].reduce(
    (n, character) => n + (WIDE.test(character) ? 1 : bold ? 0.52 : 0.47),
    0,
  ) * size;

function captionEvents(words, style) {
  const events = [];
  if (style === "highlight") {
    // Short groups of words, with the one being spoken lit up.
    let group = [];
    const flush = () => {
      group.forEach((word, i) => {
        const end = group[i + 1]?.start ?? word.end;
        const text = group
          .map((w, j) =>
            j === i
              ? `{\\c${LIME}}${clean(w.text)}{\\c${WHITE}}`
              : clean(w.text),
          )
          .join(" ");
        if (end > word.start)
          events.push(
            `Dialogue: 2,${stamp(word.start)},${stamp(end)},Highlight,,0,0,0,,${text}`,
          );
      });
      group = [];
    };
    for (const word of words) {
      const last = group.at(-1);
      if (
        group.length >= 4 ||
        (last && word.start - last.end > 0.6) ||
        (last && /[.!?]$/.test(last.text.trim()))
      )
        flush();
      group.push(word);
    }
    flush();
    return events;
  }
  const name = style === "bold" ? "Bold" : style === "box" ? "Box" : "Clean";
  for (const cue of captionCues(words))
    events.push(
      `Dialogue: 2,${stamp(cue.start)},${stamp(cue.end)},${name},,0,0,0,,${
        style === "bold" ? clean(cue.text).toUpperCase() : clean(cue.text)
      }`,
    );
  return events;
}

function titleEvents(o, W, H) {
  const start = stamp(o.start),
    end = stamp(o.end),
    title = clean(o.text),
    sub = clean(o.sub),
    accent = hexToASS(o.color);
  const shape = (layer, tags, path) =>
    `Dialogue: ${layer},${start},${end},Shape,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0${tags}\\p1}${path}{\\p0}`;
  if (o.type === "title") {
    const cy = H * (sub ? 0.46 : 0.5);
    return [
      // Dim the picture so the words carry.
      shape(
        3,
        `\\1c&H1A2610&\\1a&H38&\\fad(350,350)`,
        `m 0 0 l ${W} 0 ${W} ${H} 0 ${H}`,
      ),
      shape(
        4,
        `\\1c${accent}\\fad(350,350)`,
        roundRect(
          W / 2 - W * 0.03,
          cy - H * 0.115,
          W * 0.06,
          H * 0.008,
          H * 0.004,
        ),
      ),
      `Dialogue: 5,${start},${end},TitleCard,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(cy)})\\fad(350,350)\\fscx94\\fscy94\\t(0,500,0.5,\\fscx100\\fscy100)}${title}`,
      ...(sub
        ? [
            `Dialogue: 5,${start},${end},TitleSub,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(cy + H * 0.1)})\\fad(500,350)}${sub}`,
          ]
        : []),
    ];
  }
  if (o.type === "lowerthird") {
    const nameSize = H * 0.04,
      subSize = H * 0.026,
      padX = H * 0.03,
      h = sub ? H * 0.115 : H * 0.08,
      w =
        Math.max(textWidth(title, nameSize, true), textWidth(sub, subSize)) +
        padX * 2 +
        H * 0.012,
      x = W * 0.045,
      y = H * 0.955 - h - H * 0.03,
      slide = W * 0.03,
      move = (px, py) =>
        `\\move(${Math.round(px - slide)},${Math.round(py)},${Math.round(px)},${Math.round(py)},0,350)\\fad(250,250)`;
    const bar = (layer, colour, alpha, path) =>
      `Dialogue: ${layer},${start},${end},Shape,,0,0,0,,{\\an7${move(0, 0)}\\bord0\\shad0\\1c${colour}\\1a${alpha}\\p1}${path}{\\p0}`;
    return [
      bar(3, PINE, "&H12&", roundRect(x, y, w, h, H * 0.018)),
      bar(
        4,
        accent,
        "&H00&",
        roundRect(
          x + H * 0.014,
          y + H * 0.02,
          H * 0.006,
          h - H * 0.04,
          H * 0.003,
        ),
      ),
      `Dialogue: 5,${start},${end},LowerName,,0,0,0,,{\\an7${move(x + padX, y + (sub ? H * 0.018 : H * 0.02))}}${title}`,
      ...(sub
        ? [
            `Dialogue: 5,${start},${end},LowerSub,,0,0,0,,{\\an7${move(x + padX, y + H * 0.068)}}${sub}`,
          ]
        : []),
    ];
  }
  // Chapter label: a pill in the top-left corner.
  const size = H * 0.03,
    w = textWidth(title, size, true) + H * 0.06,
    h = H * 0.06,
    x = W * 0.04,
    y = H * 0.06;
  return [
    shape(3, `\\1c${accent}\\fad(300,300)`, roundRect(x, y, w, h, h / 2)),
    `Dialogue: 5,${start},${end},Chapter,,0,0,0,,{\\an4\\pos(${Math.round(x + H * 0.03)},${Math.round(y + h / 2)})\\fad(300,300)}${title}`,
  ];
}

// Returns the .ass document, or null when there is nothing to draw.
export function buildASS({
  width: W,
  height: H,
  words = [],
  captionStyle,
  overlays = [],
}) {
  const events = [];
  if (captionStyle && words.length)
    events.push(
      ...captionEvents(
        words,
        CAPTION_STYLES.includes(captionStyle) ? captionStyle : "clean",
      ),
    );
  for (const o of overlays)
    if (TITLE_TYPES.includes(o.type) && clean(o.text))
      events.push(...titleEvents(o, W, H));
  if (!events.length) return null;
  const px = (f) => Math.max(8, Math.round(H * f));
  // Name, Font, Size, Primary, Secondary, Outline, Back, Bold, Italic, Underline, Strike,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  const style = (
    name,
    font,
    size,
    {
      bold = 0,
      outline = 0,
      shadow = 0,
      border = 1,
      align = 2,
      outlineColour = "&H00101A10",
      back = "&H80000000",
      primary = "&H00FFFFFF",
      marginV = 0.07,
      spacing = 0,
    } = {},
  ) =>
    `Style: ${name},${font},${px(size)},${primary},&H000000FF,${outlineColour},${back},${bold ? -1 : 0},0,0,0,100,100,${spacing},0,${border},${outline},${shadow},${align},${px(0.06)},${px(0.06)},${px(marginV)},1`;
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style("Clean", "DM Sans", 0.044, {
      outline: H * 0.0028,
      shadow: H * 0.0015,
    }),
    style("Bold", "Manrope", 0.058, {
      bold: 1,
      outline: H * 0.005,
      shadow: 0,
      spacing: 0.5,
    }),
    style("Box", "DM Sans", 0.042, {
      border: 3,
      outline: H * 0.012,
      shadow: 0,
      outlineColour: "&H30151F12",
    }),
    style("Highlight", "Manrope", 0.062, {
      bold: 1,
      outline: H * 0.0055,
      shadow: 0,
      marginV: 0.09,
    }),
    style("TitleCard", "Manrope", 0.092, { bold: 1, align: 5, spacing: -1 }),
    style("TitleSub", "DM Sans", 0.036, { align: 5, primary: "&H00E6EFDD" }),
    style("LowerName", "Manrope", 0.04, { bold: 1, align: 7 }),
    style("LowerSub", "DM Sans", 0.026, { align: 7, primary: "&H00C6D1C3" }),
    style("Chapter", "Manrope", 0.03, {
      bold: 1,
      align: 4,
      primary: "&H00323E17",
    }),
    style("Shape", "DM Sans", 0.02, { align: 7 }),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
