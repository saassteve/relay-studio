// Claude, through the official Anthropic SDK.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { problem } from "../schema.mjs";
import { SYSTEM } from "./schema.mjs";

export const CLAUDE_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-2", label: "Claude Fable 5.2" },
];
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";
// Models whose safety classifiers can decline a request and that support
// re-running it on a fallback model server-side.
const WITH_FALLBACK = new Set([
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-2",
]);

const Recording = z.object({
  title: z.string(),
  description: z.string(),
  chapters: z.array(z.object({ time: z.number(), title: z.string() })),
  action_items: z.array(z.string()),
  title_card: z.object({ title: z.string(), subtitle: z.string() }),
});

function explain(error) {
  if (error instanceof Anthropic.AuthenticationError)
    return problem(
      401,
      "Claude didn't accept that API key. Check it in Workspace settings.",
    );
  if (error instanceof Anthropic.PermissionDeniedError)
    return problem(403, "This API key isn't allowed to use that Claude model.");
  if (error instanceof Anthropic.NotFoundError)
    return problem(404, "That Claude model isn't available to this API key.");
  if (error instanceof Anthropic.RateLimitError)
    return problem(
      429,
      "Claude is rate-limiting this key. Try again in a minute.",
    );
  if (error instanceof Anthropic.BadRequestError)
    return problem(
      400,
      `Claude couldn't process the request: ${error.message}`.slice(0, 300),
    );
  if (error instanceof Anthropic.APIConnectionError)
    return problem(
      503,
      "Couldn't reach Claude. Check your internet connection.",
    );
  if (error instanceof Anthropic.APIError)
    return problem(502, `Claude returned an error (${error.status}).`);
  return error;
}

export async function describeWithClaude({ apiKey, model, prompt }) {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  const id = CLAUDE_MODELS.some((m) => m.id === model)
    ? model
    : DEFAULT_CLAUDE_MODEL;
  try {
    const response = await client.beta.messages.parse({
      model: id,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        effort: "medium",
        format: betaZodOutputFormat(Recording),
      },
      ...(WITH_FALLBACK.has(id)
        ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" }
        : {}),
    });
    if (response.stop_reason === "refusal")
      throw problem(422, "Claude declined to process this transcript.");
    if (!response.parsed_output)
      throw problem(502, "Claude's reply couldn't be read. Try again.");
    return response.parsed_output;
  } catch (error) {
    throw explain(error);
  }
}

export async function testClaude({ apiKey }) {
  const client = new Anthropic({ apiKey, maxRetries: 1 });
  try {
    await client.models.retrieve(DEFAULT_CLAUDE_MODEL);
    return true;
  } catch (error) {
    throw explain(error);
  }
}
