import { useEffect, useRef, useState } from "react";
import { Copy, Code2 } from "lucide-react";
import { api, type Clip, type ShareConfig } from "./types";
export function ShareSettings({
  clip,
  onChange,
  notify,
  time = 0,
  saveRef,
  onDirty,
}: {
  clip: Clip;
  onChange: (v: Clip) => void;
  notify: (s: string) => void;
  time?: number;
  // The dialog's own button saves, so a typed password is never lost.
  saveRef?: React.RefObject<() => Promise<boolean>>;
  onDirty?: (dirty: boolean) => void;
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
    if (!(await save())) return;
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
  const initial = { access: "link", download: true, ...clip.shareConfig };
  const dirty =
    Boolean(password) ||
    clearPassword ||
    c.access !== initial.access ||
    c.download !== initial.download ||
    (c.expiresAt || "") !== (initial.expiresAt || "") ||
    emails !== (clip.shareConfig?.invitedEmails || []).join(", ");
  useEffect(() => onDirty?.(dirty), [dirty, onDirty]);
  const saving = useRef<Promise<boolean> | null>(null);
  const save = (): Promise<boolean> => {
    if (saving.current) return saving.current;
    if (!dirty) return Promise.resolve(true);
    saving.current = (async () => {
      setBusy(true);
      setError("");
      try {
        const v = await api<Clip>(`/api/videos/${clip.id}/share-settings`, {
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
        });
        onChange(v);
        setC({ access: "link", download: true, ...v.shareConfig });
        setPassword("");
        setClearPassword(false);
        notify("Sharing settings saved");
        return true;
      } catch (e) {
        setError((e as Error).message);
        return false;
      } finally {
        setBusy(false);
      }
    })().finally(() => {
      saving.current = null;
    });
    return saving.current;
  };
  if (saveRef) saveRef.current = save;
  // Once these settings are gone from the screen there is nothing left to save.
  useEffect(
    () => () => {
      if (saveRef) saveRef.current = async () => true;
    },
    [saveRef],
  );
  // Which preset matches the saved expiry, if any.
  const daysLeft = c.expiresAt
    ? (new Date(c.expiresAt).getTime() - Date.now()) / 86400000
    : 0;
  const expiry = !c.expiresAt
    ? "0"
    : ([1, 7, 30].find((d) => Math.abs(daysLeft - d) < 0.01)?.toString() ??
      "keep");
  return (
    <fieldset
      className="share-settings"
      disabled={busy}
      aria-busy={busy}
      aria-label="Sharing access settings"
    >
      <div className="device-grid">
        <label>
          Who can watch
          <select
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
          <select
            value={expiry}
            onChange={(e) => {
              const days = Number(e.target.value);
              if (e.target.value === "keep") return;
              setC({
                ...c,
                expiresAt: days
                  ? new Date(Date.now() + days * 86400000).toISOString()
                  : null,
              });
            }}
          >
            <option value="0">Never</option>
            <option value="1">In 1 day</option>
            <option value="7">In 7 days</option>
            <option value="30">In 30 days</option>
            {expiry === "keep" && c.expiresAt && (
              <option value="keep">
                On{" "}
                {new Date(c.expiresAt).toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </option>
            )}
          </select>
        </label>
      </div>
      {c.access === "invited" && (
        <label className="field">
          Invited member emails
          <input
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
        <div className="field-block">
          <label htmlFor="share-password">
            {c.hasPassword ? "Replace video password" : "Video password"}
          </label>
          <input
            id="share-password"
            aria-describedby="share-password-hint"
            type="password"
            autoComplete="new-password"
            minLength={6}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setClearPassword(false);
            }}
            placeholder={c.hasPassword ? "Password is set" : ""}
          />
          <span className="small muted" id="share-password-hint">
            Optional. At least 6 characters.
          </span>
        </div>
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
      {dirty && (
        <p className="small muted" role="status">
          {busy ? "Saving access…" : "Access changes are waiting to be saved."}
        </p>
      )}
      <div className="actions share-settings-actions">
        {dirty && (
          <button className="btn small" onClick={() => void save()}>
            Save access
          </button>
        )}
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
    </fieldset>
  );
}
