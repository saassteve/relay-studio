import { useEffect, useState } from "react";
import {
  Check,
  LoaderCircle,
  Plus,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { api, clock, type Clip, type Job, type Project } from "./types";
import { awaitJob } from "./drafts";
import type { AIState } from "./AISettings";
import "./ai-settings.css";

interface Suggestion {
  provider: string;
  title: string;
  description: string;
  titleCard: { title: string; subtitle: string };
  chapters: { time: number; title: string }[];
  coveredSeconds?: number;
}

// "Write it for me": uses the AI model connected in Workspace settings to draft a
// title, description, chapters and a title card. Nothing is applied until you say.
export function AssistCard({
  clip,
  total,
  busy,
  hasTranscript,
  edit,
  notify,
  onDetails,
  onOutline,
  setError,
}: {
  clip: Clip;
  total: number;
  busy: boolean;
  hasTranscript: boolean;
  edit: (fn: (p: Project) => void) => void;
  notify: (s: string) => void;
  onDetails: (v: Clip) => void;
  onOutline: (v: Clip) => void;
  setError: (s: string) => void;
}) {
  const [ai, setAi] = useState<AIState["settings"] | null>(null),
    [consent, setConsent] = useState(false),
    [working, setWorking] = useState(false),
    [suggestion, setSuggestion] = useState<Suggestion | null>(null),
    [used, setUsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const load = () =>
      void api<AIState>("/api/ai/settings")
        .then((s) => setAi(s.settings))
        .catch(() => {});
    load();
    // Connecting or disconnecting a provider in Settings shows here straight away.
    addEventListener("relay:ai-changed", load);
    return () => removeEventListener("relay:ai-changed", load);
  }, []);
  if (!ai) return null;
  const mark = (key: string) => setUsed((u) => ({ ...u, [key]: true }));
  const run = async () => {
    setWorking(true);
    setError("");
    try {
      const job = await api<Job>(`/api/videos/${clip.id}/assist`, {
        method: "POST",
        body: JSON.stringify({ consent }),
      });
      const done = await awaitJob(job, () => {});
      setSuggestion(done.result as unknown as Suggestion);
      notify("Suggestions are ready below");
      setUsed({});
      onOutline(await api<Clip>(`/api/videos/${clip.id}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const details = async (body: { title?: string; description?: string }) => {
    try {
      onDetails(
        await api<Clip>(`/api/videos/${clip.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      );
      notify(body.title ? "Title updated" : "Notes updated");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const overlay = (
    type: "title" | "chapter",
    start: number,
    end: number,
    text: string,
    sub = "",
  ) => ({
    id: crypto.randomUUID(),
    type,
    start: +start.toFixed(1),
    end: +Math.min(total, end).toFixed(1),
    x: 0.1,
    y: 0.1,
    w: 0.3,
    h: 0.15,
    scale: 1.8,
    text,
    sub,
    color: "#d6f475",
  });
  return (
    <div className="assist-card">
      <h2>
        <WandSparkles size={17} />
        Write it for me
      </h2>
      {!ai.ready ? (
        <>
          <p className="studio-hint">
            Connect an AI model to draft a title, description, chapters and a
            title card from the transcript. Free options are available.
          </p>
          <div className="actions">
            <button
              className="btn"
              onClick={() =>
                dispatchEvent(
                  new CustomEvent("relay:open-settings", { detail: "ai" }),
                )
              }
            >
              <Sparkles size={14} />
              Connect AI
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="studio-hint">
            {ai.label} ({ai.model}) reads this video’s transcript and suggests a
            title, description, chapters and a title card. You choose what to
            use.
          </p>
          {!ai.local && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Send this transcript to {ai.label}
            </label>
          )}
          <div className="actions">
            <button
              className="btn small primary"
              disabled={
                busy || working || !hasTranscript || (!ai.local && !consent)
              }
              onClick={() => void run()}
            >
              {working ? (
                <LoaderCircle size={14} className="spin" />
              ) : (
                <Sparkles size={14} />
              )}
              {working
                ? "Writing…"
                : suggestion
                  ? "Try again"
                  : "Write title, summary and chapters"}
            </button>
            {!hasTranscript && (
              <span className="small muted">
                Create a transcript first, in the Transcript tab.
              </span>
            )}
          </div>
        </>
      )}
      {suggestion && (
        <>
          {suggestion.coveredSeconds && (
            <p className="studio-hint">
              This provider’s limit fit the first{" "}
              {clock(suggestion.coveredSeconds)} of the transcript.
            </p>
          )}
          {suggestion.title && (
            <div className="assist-suggestion">
              <span>
                <small>Title</small>
                {suggestion.title}
              </span>
              <button
                className="btn small"
                disabled={used.title}
                onClick={() => {
                  mark("title");
                  void details({ title: suggestion.title });
                }}
              >
                {used.title ? <Check size={13} /> : null}
                {used.title ? "Used" : "Use title"}
              </button>
            </div>
          )}
          {suggestion.description && (
            <div className="assist-suggestion">
              <span>
                <small>Notes</small>
                {suggestion.description}
              </span>
              <button
                className="btn small"
                disabled={used.description}
                onClick={() => {
                  mark("description");
                  void details({ description: suggestion.description });
                }}
              >
                {used.description ? <Check size={13} /> : null}
                {used.description ? "Used" : "Use as notes"}
              </button>
            </div>
          )}
          {suggestion.titleCard.title && (
            <div className="assist-suggestion">
              <span>
                <small>Opening title card</small>
                <strong>{suggestion.titleCard.title}</strong>
                {suggestion.titleCard.subtitle &&
                  ` · ${suggestion.titleCard.subtitle}`}
              </span>
              <button
                className="btn small"
                disabled={used.card}
                onClick={() => {
                  mark("card");
                  edit((p) =>
                    p.overlays.push(
                      overlay(
                        "title",
                        0,
                        3,
                        suggestion.titleCard.title,
                        suggestion.titleCard.subtitle,
                      ),
                    ),
                  );
                  notify("Title card added. Choose Update video to share it.");
                }}
              >
                {used.card ? <Check size={13} /> : <Plus size={13} />}
                {used.card ? "Added" : "Add to video"}
              </button>
            </div>
          )}
          {suggestion.chapters.length > 0 && (
            <div className="assist-suggestion">
              <span>
                <small>Chapters</small>
                <ul className="assist-chapters">
                  {suggestion.chapters.map((c) => (
                    <li key={c.time}>
                      <span>{clock(c.time)}</span>
                      {c.title}
                    </li>
                  ))}
                </ul>
              </span>
              <button
                className="btn small"
                disabled={used.chapters}
                onClick={() => {
                  mark("chapters");
                  edit((p) =>
                    p.overlays.push(
                      ...suggestion.chapters
                        .slice(0, 12)
                        .map((c, i) =>
                          overlay(
                            "chapter",
                            // Leave the opening clear for a title card.
                            i === 0 ? Math.max(c.time, 3.2) : c.time,
                            (i === 0 ? Math.max(c.time, 3.2) : c.time) + 4,
                            `${String(i + 1).padStart(2, "0")} · ${c.title}`,
                          ),
                        )
                        .filter((o) => o.end - o.start >= 1),
                    ),
                  );
                  notify(
                    "Chapter labels added. Choose Update video to share them.",
                  );
                }}
              >
                {used.chapters ? <Check size={13} /> : <Plus size={13} />}
                {used.chapters ? "Added" : "Add labels to video"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
