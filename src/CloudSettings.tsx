import { useEffect, useState } from "react";
import { Cloud, Copy, Link2Off, PlugZap } from "lucide-react";
import { confirmDialog } from "./Modal";
import { external, SELF_HOST_URL } from "./links";
import { api } from "./types";
import { isLocal as local } from "./local";

type CloudState = { connected: boolean; url?: string; name?: string };
const here = window.relayDesktop ? "this Mac" : "this computer";

// Links that work for anyone. On someone's own computer this connects Relay to a
// server that will hold shared videos; on a server it shows how to connect an app.
export function CloudSettings({ notify }: { notify: (s: string) => void }) {
  return (
    <>
      <h3 className="studio-section-title">
        <Cloud size={17} />
        Links that work anywhere
      </h3>
      {local ? <Connect notify={notify} /> : <Accept notify={notify} />}
    </>
  );
}

function Connect({ notify }: { notify: (s: string) => void }) {
  const [state, setState] = useState<CloudState | null>(null),
    [url, setUrl] = useState(""),
    [key, setKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api<CloudState>("/api/cloud")
      .then(setState)
      .catch((e) => setError((e as Error).message));
  }, []);
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await api<CloudState>("/api/cloud", {
        method: "PUT",
        body: JSON.stringify({ url, key }),
      });
      setState(next);
      setKey("");
      notify("Connected. Send a video to get a link anyone can open.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (
      !(await confirmDialog({
        title: "Disconnect this server?",
        body: "Links you already made keep working. You won’t be able to make or update links until you connect again.",
        confirm: "Disconnect",
        cancel: "Stay connected",
      }))
    )
      return;
    try {
      setState(await api<CloudState>("/api/cloud", { method: "DELETE" }));
      notify("Server disconnected");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <>
      <p className="studio-hint">
        Your videos stay on {here}. To give someone a link they can open, Relay
        sends the finished video to a Relay server you connect here.
      </p>
      {state?.connected ? (
        <div className="cloud-connected">
          <PlugZap size={17} aria-hidden="true" />
          <span>
            <strong>Connected to {new URL(state.url!).host}</strong>
            {state.name && <small>{state.name}</small>}
          </span>
          <button className="btn small" onClick={() => void disconnect()}>
            <Link2Off size={14} />
            Disconnect
          </button>
        </div>
      ) : (
        state && (
          <form className="cloud-form" onSubmit={(e) => void connect(e)}>
            <label className="field small">
              Server address
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="relay.example.com"
                autoComplete="off"
                spellCheck={false}
                required
              />
            </label>
            <label className="field small">
              Access key
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="From the server’s Settings"
                autoComplete="off"
                required
              />
            </label>
            <button className="btn small" disabled={busy}>
              <PlugZap size={14} />
              {busy ? "Connecting…" : "Connect"}
            </button>
          </form>
        )
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!state?.connected && (
        <p className="studio-hint">
          No server yet?{" "}
          <a href={SELF_HOST_URL} {...external}>
            Host Relay yourself
          </a>
          . It is free. You need a machine that stays on and a domain name.
        </p>
      )}
    </>
  );
}

// Shown on a server: what to paste into the Relay app on your computer.
function Accept({ notify }: { notify: (s: string) => void }) {
  const [error, setError] = useState("");
  const copy = async (what: string, value: () => Promise<string> | string) => {
    try {
      await navigator.clipboard.writeText(await value());
      notify(`${what} copied`);
    } catch (e) {
      setError((e as Error).message || "Copying didn’t work in this browser.");
    }
  };
  return (
    <>
      <p className="studio-hint">
        Links from this server already work for anyone. To send videos here from
        the Relay app on your computer, open its Settings and paste these two
        things.
      </p>
      <div className="cloud-form">
        <label className="field small">
          Server address
          <span className="ai-model-row">
            <input readOnly value={location.origin} />
            <button
              className="btn small"
              onClick={() => void copy("Server address", () => location.origin)}
            >
              <Copy size={13} />
              Copy
            </button>
          </span>
        </label>
        <button
          className="btn small"
          onClick={() =>
            void copy(
              "Access key",
              async () =>
                (await api<{ token: string }>("/api/integrations")).token,
            )
          }
        >
          <Copy size={13} />
          Copy access key
        </button>
      </div>
      <p className="studio-hint">
        The access key can add and edit videos here, so treat it like a
        password.
      </p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
