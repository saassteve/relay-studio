import { useEffect, useState } from "react";
import { Cloud, Copy, ExternalLink, Link2Off, PlugZap } from "lucide-react";
import { confirmDialog } from "./Modal";
import { external, SELF_HOST_URL } from "./links";
import { api } from "./types";
import { isLocal as local } from "./local";
import type { SharingWorkspace } from "./OnlineSharing";

const here = window.relayDesktop ? "this Mac" : "this computer";

export function CloudSettings({ notify }: { notify: (s: string) => void }) {
  return (
    <>
      <h3 className="studio-section-title">
        <Cloud size={17} />
        Online sharing
      </h3>
      {local ? <Connect notify={notify} /> : <Accept notify={notify} />}
    </>
  );
}

function Connect({ notify }: { notify: (s: string) => void }) {
  const [state, setState] = useState<SharingWorkspace | null>(null);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<SharingWorkspace>("/api/cloud")
      .then(setState)
      .catch((e) => setError(e.message));
  }, []);
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setState(
        await api<SharingWorkspace>("/api/cloud", {
          method: "PUT",
          body: JSON.stringify({ url, key }),
        }),
      );
      setKey("");
      setChanging(false);
      notify(
        "Workspace connected. You choose who can watch when you share a video.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (
      !(await confirmDialog({
        title: "Disconnect online sharing?",
        body: "Videos you already shared stay online in their workspace. To remove an online copy, choose Stop sharing on that video before disconnecting.",
        confirm: "Disconnect",
        cancel: "Keep connection",
      }))
    )
      return;
    try {
      setState(await api<SharingWorkspace>("/api/cloud", { method: "DELETE" }));
      setKey("");
      setUrl("");
      notify("Workspace disconnected");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="sharing-setup">
      <p className="studio-hint">
        Recording and editing happen on {here}. Creating an online link uploads
        a finished copy to a Relay workspace you trust.
      </p>
      {!state && !error && <p role="status">Checking your connection…</p>}
      {state?.connected && (
        <>
          <div className="cloud-connected">
            <PlugZap size={17} aria-hidden="true" />
            <span>
              <strong>
                {state.reachable === false
                  ? "Connection needs attention at "
                  : "Connected to "}
                {new URL(state.url!).host}
              </strong>
              {state.name && <small>{state.name}</small>}
            </span>
            <button
              className="btn small"
              onClick={() => {
                setUrl(state.url!);
                setChanging(true);
              }}
            >
              Change workspace
            </button>
            <button className="btn small" onClick={() => void disconnect()}>
              <Link2Off size={14} />
              Disconnect
            </button>
          </div>
          <p className="small muted">
            The workspace administrator can access uploaded videos. You choose
            the audience, expiry and download button before creating a link.
          </p>
          {state.keyScope === "workspace" && (
            <p className="share-note warn">
              This connection key gives full workspace access. Ask the workspace
              owner for a sharing-only connection key.
            </p>
          )}
          {state.error && (
            <p className="share-note warn" role="status">
              {state.error}
            </p>
          )}
          <a href={state.url} {...external} className="text-button">
            <ExternalLink size={14} />
            Open online workspace
          </a>
        </>
      )}
      {state && (!state.connected || changing) && (
        <>
          <h4>
            {changing
              ? "Connect a different workspace"
              : "Connect your online workspace"}
          </h4>
          <p className="studio-hint">
            Ask the person who manages your Relay workspace for its address and
            connection key. Paste them below and choose Connect.
          </p>
          {changing && (
            <p className="share-note">
              Existing shared videos stay in their original workspace. Reconnect
              to that workspace to update or stop sharing them.
            </p>
          )}
          <form className="cloud-form" onSubmit={(e) => void connect(e)}>
            <label className="field small">
              Workspace address
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://videos.yourteam.com"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                required
                disabled={busy}
              />
            </label>
            <label className="field small">
              Connection key
              <input
                type="password"
                aria-label="Connection key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Provided by your workspace owner"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="connection-key-hint"
                required
                disabled={busy}
              />
              <span className="small muted" id="connection-key-hint">
                Treat this like a password. A sharing key can upload and remove
                shared copies in the workspace.
              </span>
            </label>
            <div className="actions">
              <button className="btn small primary" disabled={busy}>
                <PlugZap size={14} />
                {busy ? "Connecting…" : "Connect"}
              </button>
              {changing && (
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => {
                    setChanging(false);
                    setKey("");
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
          <p className="studio-hint">
            You can download a video file and send it while online sharing is
            disconnected. Already shared copies remain in their online
            workspace.
          </p>
          <details className="cut-more">
            <summary>Need an online workspace?</summary>
            <p>
              Ask your team or someone you trust to set up and maintain Relay
              online. They manage hosting, access and backups. Relay software is
              free, and hosting may have a cost.
            </p>
            <a href={SELF_HOST_URL} {...external}>
              Setup guide for the workspace administrator
            </a>
          </details>
        </>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function Accept({ notify }: { notify: (s: string) => void }) {
  const [error, setError] = useState("");
  const secure = location.protocol === "https:";
  const copy = async (what: string, value: () => Promise<string> | string) => {
    try {
      await navigator.clipboard.writeText(await value());
      notify(what + " copied");
    } catch (e) {
      setError((e as Error).message || "Copying didn’t work. Try again.");
    }
  };
  const reset = async () => {
    if (
      !(await confirmDialog({
        title: "Reset the sharing connection key?",
        body: "Apps using this sharing-only key will need the new key to upload or remove shared copies. Existing online links keep working.",
        confirm: "Reset key",
        cancel: "Keep current key",
        destructive: true,
      }))
    )
      return;
    try {
      await api("/api/cloud/key/reset", { method: "POST" });
      notify("Connection key reset. Copy the new key to reconnect your apps.");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <p className="studio-hint">
        To connect the Relay app on a Mac, copy this address and a connection
        key into its Settings → Online sharing. Viewers need to be able to open
        this workspace address in their browser.
      </p>
      {!secure && (
        <p className="share-note warn">
          Ask your administrator to enable HTTPS before connecting other
          devices.
        </p>
      )}
      <div className="cloud-form">
        <label className="field small">
          Workspace address
          <span className="ai-model-row">
            <input readOnly value={location.origin} />
            <button
              className="btn small"
              onClick={() =>
                void copy("Workspace address", () => location.origin)
              }
            >
              <Copy size={13} />
              Copy
            </button>
          </span>
        </label>
        <button
          className="btn small"
          disabled={!secure}
          onClick={() =>
            void copy(
              "Connection key",
              async () => (await api<{ key: string }>("/api/cloud/key")).key,
            )
          }
        >
          <Copy size={13} />
          Copy connection key
        </button>
      </div>
      <button
        className="text-button danger"
        disabled={!secure}
        onClick={() => void reset()}
      >
        Reset connection key
      </button>
      <p className="studio-hint">
        Give this key to people you allow to upload and remove shared videos
        here. Keep it in a password manager and share it through a secure
        channel.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
