// "Bring your own AI": each workspace can connect one AI provider with its own key.
// Nothing is sent anywhere until someone asks Relay to use it on a recording.
import { parseJSON, problem } from "../schema.mjs";
import { captionCues, getProject, outputWords } from "../project.mjs";
import {
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  describeWithClaude,
  testClaude,
} from "./anthropic.mjs";
import {
  describeWithCompatible,
  listModels,
  testCompatible,
} from "./compatible.mjs";
import { normalise, transcriptPrompt } from "./schema.mjs";

// Free tiers were checked in November 2026; limits change, so the app links to
// each provider's own page rather than promising numbers.
export const PROVIDERS = [
  {
    id: "gemini",
    label: "Google Gemini",
    free: true,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyURL: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-3.5-flash-lite",
    maxChars: 600000,
    note: "Free tier, no card. Google may use free-tier content to improve its products.",
  },
  {
    id: "groq",
    label: "Groq",
    free: true,
    baseURL: "https://api.groq.com/openai/v1",
    keyURL: "https://console.groq.com/keys",
    defaultModel: "openai/gpt-oss-120b",
    // The free plan allows only a few thousand tokens a minute.
    maxChars: 18000,
    note: "Free plan, very fast. Long videos are summarised from their first part.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    free: true,
    baseURL: "https://openrouter.ai/api/v1",
    keyURL: "https://openrouter.ai/settings/keys",
    defaultModel: "openrouter/free",
    maxChars: 300000,
    note: "Free models with a daily request limit.",
  },
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    free: false,
    keyURL: "https://platform.claude.com/settings/keys",
    defaultModel: DEFAULT_CLAUDE_MODEL,
    maxChars: 1500000,
    note: "Uses your Anthropic API key. Billed by Anthropic.",
  },
  {
    id: "openai",
    label: "ChatGPT (OpenAI)",
    free: false,
    baseURL: "https://api.openai.com/v1",
    keyURL: "https://platform.openai.com/api-keys",
    defaultModel: "",
    maxChars: 400000,
    note: "Uses your OpenAI API key. Billed by OpenAI. Load models to choose one.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    free: true,
    local: true,
    baseURL: "http://localhost:11434/v1",
    keyURL: "https://ollama.com/download",
    defaultModel: "",
    maxChars: 24000,
    note: "Runs on your own machine. Nothing leaves it. Load models to choose one.",
  },
];

const loopback = (hostname) =>
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(hostname);
function checkedURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw problem(400, "Enter a valid server address.");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && loopback(url.hostname))
  )
    throw problem(
      400,
      "The AI server must use HTTPS, or HTTP on this computer.",
    );
  return url.href.replace(/\/+$/, "");
}

export function registerAI({ app, db, owner, admin, find, jobs }) {
  const read = () =>
    parseJSON(
      db.prepare("SELECT value FROM settings WHERE key='ai'").get()?.value,
      {},
    );
  const provider = (id) => PROVIDERS.find((p) => p.id === id);
  const publicSettings = () => {
    const s = read(),
      p = provider(s.provider);
    return {
      provider: p?.id || "",
      label: p?.label || "",
      model: s.model || "",
      baseURL: p?.local ? s.baseURL || p.baseURL : "",
      keySet: Boolean(s.apiKey),
      keyHint: s.apiKey ? `…${String(s.apiKey).slice(-4)}` : "",
      ready: Boolean(p && s.model && (s.apiKey || p.local)),
      local: Boolean(p?.local),
    };
  };
  // Settings to act on: what was sent, falling back to what is saved.
  const resolve = (body = {}) => {
    const saved = read(),
      p = provider(body.provider || saved.provider);
    if (!p) throw problem(400, "Choose an AI provider first.");
    const sameProvider = p.id === saved.provider;
    const apiKey = String(
      body.apiKey || (sameProvider ? saved.apiKey : "") || "",
    ).trim();
    if (!apiKey && !p.local)
      throw problem(400, `Add your ${p.label} API key first.`);
    const baseURL = p.local
      ? checkedURL(body.baseURL || (sameProvider && saved.baseURL) || p.baseURL)
      : p.baseURL;
    const model =
      String(body.model ?? (sameProvider ? saved.model : "") ?? "").trim() ||
      p.defaultModel;
    return { provider: p, apiKey, baseURL, model };
  };

  app.get("/api/ai/settings", owner, (req, res) =>
    res.json({
      settings: publicSettings(),
      canEdit: req.user.role === "owner",
      providers: PROVIDERS.map(({ maxChars, ...p }) => ({
        ...p,
        models: p.id === "anthropic" ? CLAUDE_MODELS : undefined,
      })),
    }),
  );
  app.put("/api/ai/settings", admin, (req, res) => {
    if (req.body.provider === "" || req.body.provider === null) {
      db.prepare("DELETE FROM settings WHERE key='ai'").run();
      return res.json({ settings: publicSettings() });
    }
    const s = resolve(req.body);
    if (!s.model)
      throw problem(
        400,
        "Choose a model. Use “Load models” to see what's available.",
      );
    if (s.model.length > 200)
      throw problem(400, "That model name is too long.");
    db.prepare(
      "INSERT INTO settings VALUES('ai',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      JSON.stringify({
        provider: s.provider.id,
        apiKey: s.apiKey,
        model: s.model,
        ...(s.provider.local ? { baseURL: s.baseURL } : {}),
      }),
    );
    res.json({ settings: publicSettings() });
  });
  app.post("/api/ai/models", admin, async (req, res) => {
    const s = resolve(req.body);
    if (s.provider.id === "anthropic") {
      await testClaude(s);
      return res.json({ models: CLAUDE_MODELS.map((m) => m.id) });
    }
    res.json({ models: await listModels(s) });
  });
  app.post("/api/ai/test", admin, async (req, res) => {
    const s = resolve(req.body);
    if (s.provider.id === "anthropic") await testClaude(s);
    else await testCompatible(s);
    res.json({ ok: true, provider: s.provider.label });
  });

  app.post("/api/videos/:id/assist", owner, (req, res) => {
    const v = find(req.params.id),
      s = resolve();
    if (!s.model)
      throw problem(400, "Choose a model in Workspace settings first.");
    if (!outputWords(getProject(v), find).length)
      throw problem(400, "Transcribe this recording first.");
    if (!s.provider.local && req.body.consent !== true)
      throw problem(
        400,
        `Confirm that this transcript can be sent to ${s.provider.label}.`,
      );
    res.status(202).json(jobs.enqueue("assist", { videoId: v.id }));
  });
  jobs.register("assist", async ({ videoId }, progress) => {
    const v = find(videoId),
      s = resolve(),
      project = getProject(v),
      words = outputWords(project, find),
      duration = project.segments.reduce((n, x) => n + x.end - x.start, 0);
    if (!words.length) throw problem(400, "Transcribe this recording first.");
    const { prompt, truncated, covered } = transcriptPrompt(
      captionCues(words),
      duration,
      s.provider.maxChars,
    );
    progress(15);
    const raw =
      s.provider.id === "anthropic"
        ? await describeWithClaude({ ...s, prompt })
        : await describeWithCompatible({ ...s, prompt });
    progress(90);
    const result = normalise(raw, duration);
    // Some models answer with an empty object, or with an error in place of
    // the fields asked for.
    if (!result.title && !result.description)
      throw problem(
        502,
        `${s.provider.label} replied without a title or a summary. Try again, or pick another model in Workspace settings.`,
      );
    // Whatever the reply left out stays as it was.
    const existing = parseJSON(v.outline, {});
    const outline = {
      ...existing,
      summary: result.description || existing.summary || "",
      chapters: result.chapters.length
        ? result.chapters
        : existing.chapters || [],
      actionItems: result.actionItems.length
        ? result.actionItems
        : existing.actionItems || [],
      projectSegments: JSON.stringify(project.segments),
      generatedBy: s.provider.label,
    };
    db.prepare("UPDATE videos SET outline=? WHERE id=?").run(
      JSON.stringify(outline),
      v.id,
    );
    return {
      videoId,
      provider: s.provider.label,
      title: result.title,
      description: result.description,
      titleCard: result.titleCard,
      chapters: result.chapters,
      ...(truncated ? { coveredSeconds: Math.round(covered) } : {}),
    };
  });
}
