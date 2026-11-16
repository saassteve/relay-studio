import { useState } from "react";
import { Check, Copy, Code2, LoaderCircle } from "lucide-react";
import { api, type Clip, type ShareConfig } from "./types";
export function ShareSettings({
  clip,
  onChange,
  notify,
  time = 0,
}: {
  clip: Clip;
  onChange: (v: Clip) => void;
  notify: (s: string) => void;
  time?: number;
}) {
  const [c, setC] = useState<ShareConfig>({
      access: "link",
      download: true,
      ...clip.shareConfig,
    }),
    [password, setPassword] = useState(""),
    [clearPassword, setClearPassword] = useState(false),
    [emails, setEmails] = useState(
      (clip.shareConfig?.invitedEmails || []).join(", "),
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const copy = async (embed = false) => {
    const url = `${location.origin}${embed ? "/embed/" : "/s/"}${clip.token}${!embed && time > 0 ? `?t=${Math.floor(time)}` : ""}`;
    try {
      await navigator.clipboard.writeText(
        embed
          ? `<iframe src="${url}" title="${clip.title.replaceAll('"', "&quot;")}" allow="fullscreen" style="width:100%;aspect-ratio:16/9;border:0" allowfullscreen></iframe>`
          : url,
      );
      notify(embed ? "Embed code copied" : "Timestamp link copied");
    } catch {
      setError(
        "Clipboard access is unavailable. Copy the main share link instead.",
      );
    }
  };
  return (
    <div className="share-settings">
      <div className="device-grid">
        <label>
          Who can watch
          <select
            aria-label="Viewer access"
            value={c.access}
            onChange={(e) =>
              setC({ ...c, access: e.target.value as ShareConfig["access"] })
            }
          >
            <option value="link">Anyone with this link</option>
            <option value="workspace">Workspace members</option>
            <option value="invited">Specific workspace members</option>
          </select>
        </label>
        <label>
          Expires
          <input
            aria-label="Link expiration"
            type="datetime-local"
            value={
              c.expiresAt
                ? new Date(
                    new Date(c.expiresAt).getTime() -
                      new Date().getTimezoneOffset() * 60000,
                  )
                    .toISOString()
                    .slice(0, 16)
                : ""
            }
            onChange={(e) =>
              setC({
                ...c,
                expiresAt: e.target.value
                  ? new Date(e.target.value).toISOString()
                  : null,
              })
            }
          />
        </label>
      </div>
      {c.access === "invited" && (
        <label className="field">
          Invited member emails
          <input
            aria-label="Invited member emails"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            placeholder="sam@example.com, alex@example.com"
          />
          <span className="small muted">
            These people must sign in with their workspace account.
          </span>
        </label>
      )}
      <div className="device-grid">
        <label>
          {c.hasPassword ? "Replace video password" : "Video password"}
          <input
            aria-label="Video password"
            type="password"
            autoComplete="new-password"
            minLength={6}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setClearPassword(false);
            }}
            placeholder={
              c.hasPassword
                ? "Password is set"
                : "Optional · at least 6 characters"
            }
          />
        </label>
        <div className="share-options">
          <label className="check-label">
            <input
              type="checkbox"
              checked={c.download}
              onChange={(e) => setC({ ...c, download: e.target.checked })}
            />
            Allow file downloads
          </label>
          {c.hasPassword && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={clearPassword}
                onChange={(e) => setClearPassword(e.target.checked)}
              />
              Remove current password
            </label>
          )}
        </div>
      </div>
      <div className="actions share-settings-actions">
        <button
          className="btn small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const v = await api<Clip>(
                `/api/videos/${clip.id}/share-settings`,
                {
                  method: "PUT",
                  body: JSON.stringify({
                    ...c,
                    invitedEmails: emails
                      .split(",")
                      .map((e) => e.trim())
                      .filter(Boolean),
                    ...(clearPassword
                      ? { password: "" }
                      : password
                        ? { password }
                        : {}),
                  }),
                },
              );
              onChange(v);
              setC({ access: "link", download: true, ...v.shareConfig });
              setPassword("");
              setClearPassword(false);
              notify("Viewer access settings saved");
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle size={14} className="spin" />
          ) : (
            <Check size={14} />
          )}
          Save access settings
        </button>
        <button className="text-button small" onClick={() => void copy()}>
          <Copy size={14} />
          Link to {Math.floor(time / 60)}:
          {String(Math.floor(time % 60)).padStart(2, "0")}
        </button>
        <button className="text-button small" onClick={() => void copy(true)}>
          <Code2 size={14} />
          Embed
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
