// Captions, titles and plain text are rendered by libass from a generated .ass file:
// styled captions (including word-by-word highlight), title cards, lower thirds
// and chapter labels, each with its own entrance and exit, text overlays and
// cursor dots.
// libass falls back to a system font for characters the bundled fonts lack.
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
// Text drawn exactly as typed. Nothing in it is read as an override code, a line
// break code or a new line of the script: "{" and "}" are escaped, a backslash is
// parted from what follows it by a zero-width space (which libass does not draw),
// and every kind of line ending becomes a line break, except one at the very end,
// which adds no line. Spaces are made non-breaking because libass drops ordinary
// ones at the ends of a line.
const literal = (s) => {
  const text = String(s ?? "")
    .replace(/\r\n?|[\n\v\f\u0085\u2028\u2029]/g, "\n")
    .replace(/\n$/, "")
    .replace(/[\0-\x08\x0e-\x1f\x7f]/g, "")
    .replace(/\t/g, "    ")
    .replace(/[\\{}]/g, (c) => (c === "\\" ? "\\\u200b" : `\\${c}`));
  return (
    text &&
    text
      .split("\n")
      // An empty line would be drawn at half height.
      .map((line) => line.replaceAll(" ", "\u00a0") || "\u00a0")
      .join("\\N")
  );
};
// libass asks the system for another font when the bundled ones lack a character.
// On macOS 15 and later the answer for Chinese characters is PingFang, in a format
// FreeType cannot read, and they come out as empty boxes. So on a Mac, and only
// there, runs of them name a system font that it can read. This goes for all the
// text there is: captions, titles and text overlays.
const HAN_FONT = process.platform === "darwin" ? "Hiragino Sans GB" : null,
  HAN =
    /[\u2e80-\u312f\u3190-\u9fff\uf900-\ufaff\ufe10-\ufe1f\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{323af}]+/gu;
// A caption on a see-through box takes the font for the whole line, because each
// change of font starts a box of its own and they would show where they overlap.
const readable = (text, whole = false) =>
  !HAN_FONT
    ? text
    : whole
      ? text.search(HAN) < 0
        ? text
        : `{\\fn${HAN_FONT}}${text}`
      : text.replace(HAN, (run) => `{\\fn${HAN_FONT}}${run}{\\fn}`);
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
              ? `{\\c${LIME}}${readable(clean(w.text))}{\\c${WHITE}}`
              : readable(clean(w.text)),
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
      `Dialogue: 2,${stamp(cue.start)},${stamp(cue.end)},${name},,0,0,0,,${readable(
        style === "bold" ? clean(cue.text).toUpperCase() : clean(cue.text),
        style === "box",
      )}`,
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
      `Dialogue: 5,${start},${end},TitleCard,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(cy)})\\fad(350,350)\\fscx94\\fscy94\\t(0,500,0.5,\\fscx100\\fscy100)}${readable(title)}`,
      ...(sub
        ? [
            `Dialogue: 5,${start},${end},TitleSub,,0,0,0,,{\\an5\\pos(${Math.round(W / 2)},${Math.round(cy + H * 0.1)})\\fad(500,350)}${readable(sub)}`,
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
      `Dialogue: 5,${start},${end},LowerName,,0,0,0,,{\\an7${move(x + padX, y + (sub ? H * 0.018 : H * 0.02))}}${readable(title)}`,
      ...(sub
        ? [
            `Dialogue: 5,${start},${end},LowerSub,,0,0,0,,{\\an7${move(x + padX, y + H * 0.068)}}${readable(sub)}`,
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
    `Dialogue: 5,${start},${end},Chapter,,0,0,0,,{\\an4\\pos(${Math.round(x + H * 0.03)},${Math.round(y + h / 2)})\\fad(300,300)}${readable(title)}`,
  ];
}

// libass sizes a font by the height of its line. A line of DM Sans is 1.322 em
// high, and its tall letters reach to 0.292 em below the top of that line.
const TEXT_LINE = 1.322,
  TEXT_TOP = 0.292;
// When an effect that is on from its start to its end, both included, is on as a
// subtitle, or null if no frame falls in that time. Subtitle times are in
// hundredths of a second: these fall between frames.
function shown(o, fps) {
  const first = Math.ceil(o.start * fps - 1e-6),
    last = Math.floor(o.end * fps + 1e-6);
  return last < first
    ? null
    : `${stamp(Math.floor((first * 100) / fps) / 100)},${stamp((Math.floor((last * 100) / fps) + 1) / 100)}`;
}
// A text overlay: bold DM Sans in the overlay's colour on a dark box, with the top
// left of the letters at the overlay's x and y.
function textEvents(o, W, H, fps) {
  const text = readable(literal(o.text)),
    times = shown(o, fps);
  if (!text || !times) return [];
  const size = Math.max(18, Math.round(H * 0.045)),
    x = Math.round(o.x * W),
    y = Math.round(o.y * H) - size * TEXT_TOP,
    tags = [
      `\\an7\\pos(${x},${y.toFixed(2)})`,
      // Only the line breaks that were typed.
      "\\q2",
      `\\fs${(size * TEXT_LINE).toFixed(2)}`,
      `\\1c${hexToASS(o.color)}`,
      // How far the box reaches past the text: 10 px at each side of a 720p
      // frame, and as far above and below as the preview's box does.
      `\\xshad${(size * 0.3125).toFixed(2)}\\yshad${(size * 0.14).toFixed(2)}`,
    ];
  return [`Dialogue: 0,${times},Text,,0,0,0,,{${tags.join("")}}${text}`];
}
// A cursor: a dot in the overlay's colour, drawn as a shape because the bundled
// fonts have no "●". It is where and as big as the preview shows that character,
// which browsers take from Helvetica or Arial at 0.037 of the frame's height: 0.43
// of that size across, centred 0.3 of it right and 0.56 down from the overlay's
// x and y.
function cursorEvents(o, W, H, fps) {
  const times = shown(o, fps);
  if (!times) return [];
  // In eighths of a pixel, to keep so small a circle round.
  const size = H * 0.037,
    f = (n) => Math.round(n * 8),
    cx = f(Math.round(o.x * W) + size * 0.301),
    cy = f(Math.round(o.y * H) + size * 0.557),
    r = f(size * 0.215),
    k = Math.round(r * 0.5523);
  const circle = [
    `m ${cx + r} ${cy}`,
    `b ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r}`,
    `b ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy}`,
    `b ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r}`,
    `b ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy}`,
  ].join(" ");
  return [
    `Dialogue: 0,${times},Shape,,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c${hexToASS(o.color)}\\p4}${circle}{\\p0}`,
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
  return events.length ? script(W, H, events) : null;
}

// The same for text overlays, which are drawn as typed, and for cursors. They have
// a script of their own because it turns kerning on, as the preview and the old
// text renderer had it.
export function buildTextASS({ width: W, height: H, overlays = [], fps = 30 }) {
  const events = overlays.flatMap((o) =>
    o.type === "text"
      ? textEvents(o, W, H, fps)
      : o.type === "cursor"
        ? cursorEvents(o, W, H, fps)
        : [],
  );
  return events.length ? script(W, H, events, true) : null;
}

function script(W, H, events, kerning = false) {
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
    ...(kerning ? ["Kerning: yes"] : []),
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
    // Border style 4 is one box behind the whole text, in the back colour.
    style("Text", "DM Sans", 0.045 * TEXT_LINE, {
      bold: 1,
      align: 7,
      border: 4,
      back: "&H73000000",
    }),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}
