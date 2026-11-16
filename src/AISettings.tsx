import { radio } from "./Modal";
import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  PlugZap,
  Sparkles,
} from "lucide-react";
import { api } from "./types";
import "./ai-settings.css";
import { external } from "./links";

export interface AIProvider {
  id: string;
  label: string;
  free: boolean;
  local?: boolean;
  baseURL?: string;
  keyURL: string;
  defaultModel: string;
  note: string;
  models?: { id: string; label: string }[];
}
export interface AIState {
  settings: {
    provider: string;
    label: string;
    model: string;
    baseURL: string;
    keySet: boolean;
    keyHint: string;
    ready: boolean;
    local: boolean;
  };
  canEdit: boolean;
  providers: AIProvider[];
}
// External pages open in the browser; in the Mac app a plain link does that.
export function AISettings({ notify }: { notify: (s: string) => void }) {
  const [state, setState] = useState<AIState | null>(null),
    [provider, setProvider] = useState(""),
    [apiKey, setApiKey] = useState(""),
    [model, setModel] = useState(""),
    [baseURL, setBaseURL] = useState(""),
    [models, setModels] = useState<string[]>([]),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [connector, setConnector] = useState<{
      token: string;
      mcpPath: string;
    } | null>(null);
  const load = async () => {
    const s = await api<AIState>("/api/ai/settings");
    setState(s);
    setProvider(s.settings.provider || "gemini");
    setModel(s.settings.model);
    setBaseURL(s.settings.baseURL);
    setApiKey("");
  };
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, []);
  if (!state) return null;
  const current =
    state.providers.find((p) => p.id === provider) || state.providers[0];
  const saved = state.settings.provider === current.id;
  const body = () => ({
    provider: current.id,
    ...(apiKey ? { apiKey } : {}),
    ...(current.local ? { baseURL: baseURL || current.baseURL } : {}),
    model: model || current.defaultModel,
  });
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const choose = (id: string) => {
    const p = state.providers.find((x) => x.id === id)!;
    setProvider(id);
    setApiKey("");
    setModels([]);
    setError("");
    setModel(
      state.settings.provider === id ? state.settings.model : p.defaultModel,
    );
    setBaseURL(
      state.settings.provider === id ? state.settings.baseURL : p.baseURL || "",
    );
  };
  const modelChoices = current.models?.map((m) => m.id) || models;
  const mcpURL = connector ? `${location.origin}${connector.mcpPath}` : "";
  const command = connector
    ? `claude mcp add --transport http relay ${mcpURL} --header "Authorization: Bearer ${connector.token}"`
    : "";
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied");
    } catch {
      setError("Couldn't copy. Select the text and copy it yourself.");
    }
  };
  return (
    <div className="ai-settings">
      <h3 className="studio-section-title">
        <Sparkles size={17} />
        AI assistant
      </h3>
      <p className="studio-hint">
        Connect an AI model to write titles, summaries, chapters and title
        cards. Transcription and captions always run on your device; a
        transcript is only sent to the provider you choose, when you ask.
      </p>
      {state.settings.ready && (
        <p className="ai-connected" role="status">
          <Check size={14} /> Connected to {state.settings.label} ·{" "}
          {state.settings.model}
        </p>
      )}
      {!state.canEdit ? (
        <p className="studio-hint">Only the workspace owner can change this.</p>
      ) : (
        <>
          <div
            className="ai-providers"
            role="radiogroup"
            aria-label="AI provider"
          >
            {state.providers.map((p) => (
              <button
                type="button"
                key={p.id}
                {...radio(current.id === p.id)}
                className={current.id === p.id ? "selected" : undefined}
                onClick={() => choose(p.id)}
              >
                <strong>{p.label}</strong>
                <span className={p.free ? "tag free" : "tag"}>
                  {p.local ? "Local" : p.free ? "Free tier" : "Your key"}
                </span>
              </button>
            ))}
          </div>
          <p className="studio-hint">{current.note}</p>
          {current.local ? (
            <label className="field small">
              Server address
              <input
                aria-label="AI server address"
                value={baseURL}
                onChange={(e) => setBaseURL(e.target.value)}
                placeholder={current.baseURL}
              />
            </label>
          ) : (
            <label className="field small">
              <span className="ai-key-label">
                API key
                <a href={current.keyURL} {...external}>
                  {current.free ? "Get a free key" : "Get a key"}
                  <ArrowUpRight size={12} />
                </a>
              </span>
              <input
                aria-label="AI API key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  saved && state.settings.keySet
                    ? `Saved (${state.settings.keyHint}). Paste a new key to replace it.`
                    : "Paste your key"
                }
              />
            </label>
          )}
          <label className="field small">
            Model
            <span className="ai-model-row">
              {modelChoices.length ? (
                <select
                  aria-label="AI model"
                  value={model || current.defaultModel}
                  onChange={(e) => setModel(e.target.value)}
                >
                  {[
                    ...new Set([
                      model || current.defaultModel,
                      ...modelChoices,
                    ]),
                  ]
                    .filter(Boolean)
                    .map((m) => (
                      <option key={m} value={m}>
                        {current.models?.find((x) => x.id === m)?.label || m}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  aria-label="AI model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={current.defaultModel || "Load models to choose"}
                />
              )}
              {!current.models && (
                <button
                  type="button"
                  className="btn small"
                  disabled={!!busy}
                  onClick={() =>
                    void run("models", async () => {
                      const r = await api<{ models: string[] }>(
                        "/api/ai/models",
                        {
                          method: "POST",
                          body: JSON.stringify(body()),
                        },
                      );
                      setModels(r.models);
                      if (!model && !current.defaultModel && r.models[0])
                        setModel(r.models[0]);
                    })
                  }
                >
                  {busy === "models" && (
                    <LoaderCircle size={13} className="spin" />
                  )}
                  Load models
                </button>
              )}
            </span>
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <div className="actions">
            <button
              className="btn primary"
              disabled={!!busy}
              onClick={() =>
                void run("save", async () => {
                  await api("/api/ai/test", {
                    method: "POST",
                    body: JSON.stringify(body()),
                  });
                  await api("/api/ai/settings", {
                    method: "PUT",
                    body: JSON.stringify(body()),
                  });
                  await load();
                  notify(`Connected to ${current.label}`);
                })
              }
            >
              {busy === "save" ? (
                <LoaderCircle size={13} className="spin" />
              ) : (
                <PlugZap size={14} />
              )}
              Test and connect
            </button>
            {state.settings.provider && (
              <button
                className="text-button small"
                disabled={!!busy}
                onClick={() =>
                  void run("off", async () => {
                    await api("/api/ai/settings", {
                      method: "PUT",
                      body: JSON.stringify({ provider: "" }),
                    });
                    await load();
                    notify("AI disconnected");
                  })
                }
              >
                Disconnect
              </button>
            )}
          </div>
          <h3 className="studio-section-title">
            <PlugZap size={17} />
            Edit from Claude or ChatGPT
          </h3>
          <p className="studio-hint">
            Relay has a connector (MCP) so an AI app can edit your videos by
            chat: “cut the first 20 seconds, add a title card and switch to side
            by side for the demo”. It uses the app and plan you already have.
          </p>
          {!connector ? (
            <button
              className="btn small"
              onClick={() =>
                void run("connector", async () =>
                  setConnector(await api("/api/integrations")),
                )
              }
            >
              <KeyRound size={14} />
              Show connection details
            </button>
          ) : (
            <div className="ai-connector">
              <label className="field small">
                Claude Code: run this once in Terminal
                <span className="ai-model-row">
                  <input
                    readOnly
                    value={command.replace(connector.token, "••••••••")}
                  />
                  <button
                    className="btn small"
                    onClick={() => void copy(command)}
                  >
                    <Copy size={13} />
                    Copy
                  </button>
                </span>
              </label>
              <label className="field small">
                Other apps: add a remote MCP server with this address
                <span className="ai-model-row">
                  <input readOnly value={mcpURL} />
                  <button
                    className="btn small"
                    onClick={() => void copy(mcpURL)}
                  >
                    <Copy size={13} />
                    Copy
                  </button>
                </span>
              </label>
              <button
                className="text-button small"
                onClick={() =>
                  void copy(`Authorization: Bearer ${connector.token}`)
                }
              >
                <Copy size={13} />
                Copy the access header
              </button>
              <p className="studio-hint">
                The access token can edit every video in this workspace, so
                treat it like a password.
                {["127.0.0.1", "localhost"].includes(location.hostname) &&
                  " Apps on this computer can connect now. The Claude and ChatGPT web apps need a public address, which means hosting Relay on a server."}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
