import { problem } from "./schema.mjs";

const escapeHTML = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// One line of at most `max` characters, ending at a word where it has to be cut.
const line = (value, max) => {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  const letters = Array.from(text);
  if (letters.length <= max) return text;
  const cut = letters.slice(0, max - 1).join(""),
    space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};
// Puts a page's own title and tags in place of the ones the app's page ships with.
export const withTags = (html, tags) =>
  html
    .replace(/<title>[\s\S]*?<\/title>\s*/i, "")
    .replace(/<meta\s+name="description"[^>]*>\s*/i, "")
    // A function, so a "$" in a video's title is never read as a pattern.
    .replace(/\s*<\/head>/i, () => `\n    ${tags.join("\n    ")}\n  </head>`);

// What chat apps and social sites show when a shared link is pasted into them.
export function registerPreview({ app, shell, sharing }) {
  const { byToken, guard, shareData } = sharing;
  // A preview is fetched by the chat app, and shown to everyone who can see the
  // message. So it is only ever made for a link that a visitor with no account,
  // no video password and no cookie may open: the same check the watch page makes
  // for such a visitor, whoever is asking here.
  const open = (token) => {
    const v = byToken(token);
    guard({ headers: {}, user: null }, v);
    return v;
  };
  const jpeg = (v) =>
    /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(v.thumbnail || "")?.[1];
  app.get("/api/share/:token/thumbnail.jpg", (req, res) => {
    const data = jpeg(open(req.params.token));
    if (!data) throw problem(404, "This video has no preview image.");
    // Kept briefly, so a link that is later locked soon stops handing it out.
    res
      .set({
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=300",
      })
      .send(Buffer.from(data, "base64"));
  });
  // Without the app's page there is nothing to add tags to (the Mac app, whose
  // links only open on this computer, serves its page unchanged).
  if (!shell) return;
  const tag = (name, content) =>
    `<meta ${name.startsWith("og:") ? "property" : "name"}="${name}" content="${escapeHTML(content)}" />`;
  // A shared link is for the people it was sent to, not for search engines.
  const unlisted = tag("robots", "noindex");
  const generic = [
    "<title>Relay</title>",
    unlisted,
    tag("og:title", "Relay"),
    tag("og:site_name", "Relay"),
    tag("og:type", "website"),
    tag("twitter:card", "summary"),
  ];
  const tags = (req) => {
    try {
      const v = open(req.params.token),
        shared = shareData(v),
        origin = process.env.PUBLIC_URL
          ? new URL(process.env.PUBLIC_URL).origin
          : `${req.protocol}://${req.get("host")}`,
        link = `${origin}/s/${encodeURIComponent(v.token)}`,
        title = line(shared.title, 160) || "Untitled video",
        description = line(shared.description || shared.outline?.summary, 200);
      return [
        `<title>${escapeHTML(title)} · Relay</title>`,
        unlisted,
        ...(description
          ? [
              tag("description", description),
              tag("og:description", description),
            ]
          : []),
        tag("og:title", title),
        tag("og:site_name", "Relay"),
        tag("og:type", "video.other"),
        tag("og:url", link),
        // The revision makes a re-rendered video fetch its new picture.
        ...(jpeg(v)
          ? [
              tag(
                "og:image",
                `${origin}/api/share/${encodeURIComponent(v.token)}/thumbnail.jpg?r=${Number(v.revision) || 0}`,
              ),
              // Every video's picture is made at this size (see render.mjs).
              tag("og:image:width", "640"),
              tag("og:image:height", "360"),
            ]
          : []),
        tag("twitter:card", jpeg(v) ? "summary_large_image" : "summary"),
      ];
    } catch {
      // Locked, expired, turned off or unknown: all look the same from outside.
      return generic;
    }
  };
  app.get(["/s/:token", "/embed/:token"], async (req, res) => {
    const html = await shell(req);
    res
      .set("Cache-Control", "no-cache")
      .type("html")
      .send(withTags(html, tags(req)));
  });
}
