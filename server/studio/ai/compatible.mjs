// Providers that speak the OpenAI-style chat completions API: the free tiers
// (Gemini, Groq, OpenRouter), OpenAI itself, and an Ollama server at an address
// the workspace chooses.
import { problem } from "../schema.mjs";
import { JSON_SCHEMA, SYSTEM } from "./schema.mjs";

const headers = (provider, apiKey) => ({
  "Content-Type": "application/json",
  ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  ...(provider.id === "openrouter" ? { "X-Title": "Relay" } : {}),
});
const join = (base, pathname) => `${base.replace(/\/+$/, "")}/${pathname}`;

function explain(provider, status, body) {
  const detail = String(
    body?.error?.message || body?.error || body?.message || "",
  ).slice(0, 200);
  if (status === 401 || status === 403)
    return problem(
      401,
      `${provider.label} didn't accept that API key. Check it in Workspace settings.`,
    );
  if (status === 404)
    return problem(
      404,
      `${provider.label} doesn't have that model. Pick another in Workspace settings.`,
    );
  if (status === 429)
    return problem(
      429,
      `${provider.label}'s free limit was reached. Wait a little and try again.`,
    );
  return problem(
    502,
    `${provider.label} returned an error (${status})${detail ? `: ${detail}` : "."}`,
  );
}

async function request(provider, baseURL, apiKey, pathname, init) {
  // A model on someone's own machine can take minutes to write a whole reply.
  const limit = provider.local && init.method === "POST" ? 900000 : 120000;
  const slow = (e) => {
    if (e?.name !== "TimeoutError") return null;
    return problem(
      504,
      `${provider.label} took more than ${limit / 60000} minutes to answer. ${provider.local ? "Try a smaller model or a shorter video." : "Try again in a moment."}`,
    );
  };
  let response;
  try {
    response = await fetch(join(baseURL, pathname), {
      ...init,
      headers: headers(provider, apiKey),
      // A server at an address someone typed in must not send Relay on to
      // another one, such as a machine inside the network.
      redirect: provider.local ? "error" : "follow",
      signal: AbortSignal.timeout(limit),
    });
  } catch (e) {
    if (slow(e)) throw slow(e);
    if (/redirect/i.test(e?.cause?.message || ""))
      throw problem(
        502,
        `${provider.label} answered with a redirect to another address, which Relay does not follow. Enter the server's own address.`,
      );
    throw problem(
      503,
      `Couldn't reach ${provider.label}. Check your connection${provider.id === "ollama" ? " and that Ollama is running" : ""}.`,
    );
  }
  const body = await response.json().catch((e) => {
    if (slow(e)) throw slow(e);
    return null;
  });
  return { response, body };
}

export async function listModels({ provider, baseURL, apiKey }) {
  const { response, body } = await request(
    provider,
    baseURL,
    apiKey,
    "models",
    { method: "GET" },
  );
  if (!response.ok) throw explain(provider, response.status, body);
  return (Array.isArray(body?.data) ? body.data : [])
    .map((m) => String(m.id || "").replace(/^models\//, ""))
    .filter(Boolean)
    .sort()
    .slice(0, 400);
}

// Pulls the first JSON object out of a reply, for models that wrap it in prose.
function extractJSON(text) {
  const start = text.indexOf("{"),
    end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function describeWithCompatible({
  provider,
  baseURL,
  apiKey,
  model,
  prompt,
}) {
  const messages = [
    {
      role: "system",
      content: `${SYSTEM}\n\nReply with a single JSON object and nothing else, using exactly these keys: title, description, chapters (array of {time, title}), action_items (array of strings), title_card ({title, subtitle}).`,
    },
    { role: "user", content: prompt },
  ];
  // Strict schema first; fall back for models and gateways that don't support it.
  const formats = [
    {
      type: "json_schema",
      json_schema: { name: "recording", strict: true, schema: JSON_SCHEMA },
    },
    { type: "json_object" },
    null,
  ];
  let last;
  for (const format of formats) {
    const { response, body } = await request(
      provider,
      baseURL,
      apiKey,
      "chat/completions",
      {
        method: "POST",
        body: JSON.stringify({
          model,
          messages,
          ...(format ? { response_format: format } : {}),
        }),
      },
    );
    if (response.ok) {
      const parsed = extractJSON(
        String(body?.choices?.[0]?.message?.content || ""),
      );
      if (parsed) return parsed;
      last = problem(
        502,
        `${provider.label} replied, but not in a form Relay could read. Try another model.`,
      );
      continue;
    }
    last = explain(provider, response.status, body);
    // Only a rejected request shape is worth retrying in a simpler form.
    if (![400, 422].includes(response.status)) throw last;
  }
  throw last;
}

export async function testCompatible({ provider, baseURL, apiKey }) {
  await listModels({ provider, baseURL, apiKey });
  return true;
}
