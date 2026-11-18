import { useEffect, useState } from "react";
import { Copy, ExternalLink, Link, LoaderCircle } from "lucide-react";
import { api, type Clip, type ShareConfig } from "./types";
import { confirmDialog } from "./Modal";
import { external } from "./links";

export interface SharingWorkspace {
  connected: boolean;
  url?: string;
  name?: string;
  privacySupported?: boolean;
  publicLinksAllowed?: boolean;
  keyScope?: "sharing" | "workspace";
  reachable?: boolean;
  error?: string;
}
type LinkStatus = {
  url: string;
  manageUrl?: string;
  share?: Pick<
    ShareConfig,
    "access" | "download" | "expiresAt" | "hasPassword"
  >;
};
const address = (value?: string) => {
  try {
    return new URL(value || "");
  } catch {
    return null;
  }
};

export function OnlineSharing({
  clip,
  onChange,
  notify,
  pending,
  updating,
  prepare,
  onBusy,
  onConnected,
  onConnect,
}: {
  clip: Clip;
  onChange: (clip: Clip) => void;
  notify: (message: string) => void;
  pending: boolean;
  updating: boolean;
  prepare: () => Promise<boolean>;
  onBusy: (busy: boolean) => void;
  onConnected: (connected: boolean) => void;
  onConnect: () => void;
}) {
  const [workspace, setWorkspace] = useState<SharingWorkspace | null>(null);
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [accessError, setAccessError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [audience, setAudience] = useState("workspace");
  const [password, setPassword] = useState("");
  const [days, setDays] = useState("7");
  const [download, setDownload] = useState(false);
  const published = address(clip.cloud?.url);
  const target = address(workspace?.url);
  const sameWorkspace =
    workspace?.connected && published?.origin === target?.origin;
  const needsPrivacy = !clip.cloud || clip.cloud.unverified;
  const canPublish =
    workspace?.connected &&
    workspace.reachable !== false &&
    (!needsPrivacy || workspace.privacySupported === true) &&
    (!clip.cloud || sameWorkspace);

  useEffect(() => {
    let current = true;
    setWorkspace(null);
    setStatus(null);
    setConnectionError("");
    setAccessError("");
    void api<SharingWorkspace>("/api/cloud")
      .then(async (next) => {
        if (!current) return;
        setWorkspace(next);
        onConnected(next.connected);
        if (
          !clip.cloud ||
          !next.connected ||
          !next.privacySupported ||
          address(clip.cloud.url)?.origin !== address(next.url)?.origin ||
          next.reachable === false
        )
          return;
        try {
          const found = await api<LinkStatus>(
            "/api/videos/" + clip.id + "/cloud",
          );
          if (!current) return;
          setStatus(found);
          if (clip.cloud.unverified)
            onChange(await api<Clip>("/api/videos/" + clip.id));
        } catch (e) {
          if (current) setAccessError((e as Error).message);
        }
      })
      .catch((e) => {
        if (current) {
          setConnectionError((e as Error).message);
          onConnected(false);
        }
      });
    return () => {
      current = false;
    };
  }, [clip.id, clip.cloud?.url, refresh, onConnected]);

  const send = async () => {
    if (busy || !canPublish) return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      if (!(await prepare()))
        throw new Error(
          "The latest edits could not be prepared. Try Update video again.",
        );
      const sharing = needsPrivacy
        ? {
            access: audience === "workspace" ? "workspace" : "link",
            password: audience === "password" ? password : "",
            expiresAt: Number(days)
              ? new Date(Date.now() + Number(days) * 86400000).toISOString()
              : null,
            download,
          }
        : undefined;
      onChange(
        await api<Clip>("/api/videos/" + clip.id + "/cloud", {
          method: "POST",
          body: JSON.stringify({ workspaceUrl: workspace!.url, sharing }),
        }),
      );
      setPassword("");
      notify("Online link ready");
    } catch (e) {
      setError((e as Error).message);
      // Reconcile an upload whose response was lost, so its destination remains visible.
      try {
        onChange(await api<Clip>("/api/videos/" + clip.id));
      } catch {
        /* The error remains visible. */
      }
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const stop = async () => {
    if (
      !(await confirmDialog({
        title: "Stop sharing this video?",
        body: "The online copy will be removed and this link will stop working. People who already saved a copy can keep it.",
        confirm: "Stop sharing",
        cancel: "Keep sharing",
        destructive: true,
      }))
    )
      return;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      onChange(
        await api<Clip>("/api/videos/" + clip.id + "/cloud", {
          method: "DELETE",
        }),
      );
      notify("Online sharing stopped");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(status?.url || clip.cloud!.url);
      notify("Share link copied");
    } catch {
      setError("Select the link below and copy it manually.");
    }
  };
  const share = status?.share;
  const localWorkspace =
    target && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
  const manage = address(status?.manageUrl || clip.cloud?.manageUrl);
  const manageUrl =
    manage && manage.origin === published?.origin
      ? manage.href
      : published?.origin;

  return (
    <section
      className="online-sharing"
      aria-label="Online sharing"
      aria-busy={busy}
    >
      {clip.cloud && (
        <>
          <h3>
            {clip.cloud.unverified
              ? "Upload needs checking"
              : "Shared in workspace"}
          </h3>
          <p className="share-note">
            {clip.cloud.unverified
              ? "A copy may already be in your workspace. Check its status or stop sharing before trying again."
              : "A copy of this video is stored at " +
                (published?.host || "your online workspace") +
                "."}
          </p>
          {!clip.cloud.unverified && (
            <label className="share-link">
              <Link size={18} aria-hidden="true" />
              <input
                aria-label="Shared video link"
                readOnly
                value={status?.url || clip.cloud.url}
                onFocus={(e) => e.target.select()}
              />
              <button className="btn primary" onClick={() => void copy()}>
                <Copy size={14} />
                Copy link
              </button>
            </label>
          )}
          {share ? (
            <p className="share-audience" role="status">
              <strong>
                {share.access === "workspace"
                  ? "Workspace members can watch"
                  : share.access === "invited"
                    ? "Invited workspace members can watch"
                    : share.hasPassword
                      ? "Viewers need the link and password"
                      : "Anyone with the link can watch"}
              </strong>
              {share.hasPassword && share.access !== "link" && (
                <span>A video password is also required.</span>
              )}
              <span>
                {share.expiresAt
                  ? "Expires " + new Date(share.expiresAt).toLocaleDateString()
                  : "This link has no expiry."}
                {" · "}
                {share.download
                  ? "Download button enabled"
                  : "Download button hidden"}
              </span>
            </p>
          ) : sameWorkspace &&
            workspace?.privacySupported &&
            workspace.reachable !== false &&
            !accessError ? (
            <p role="status" className="small muted">
              Checking who can watch…
            </p>
          ) : (
            <p className="small muted">
              Access is controlled in the online workspace.
            </p>
          )}
          {manageUrl && (
            <a href={manageUrl} {...external} className="text-button">
              <ExternalLink size={14} />
              Manage access in workspace
            </a>
          )}
          {accessError && (
            <p className="share-note warn" role="status">
              {accessError}
            </p>
          )}
          {!sameWorkspace && workspace && (
            <p className="share-note warn">
              Reconnect to {published?.host || "the original workspace"} to
              update or stop sharing this copy.
            </p>
          )}
          <div className="share-actions">
            {!needsPrivacy &&
              canPublish &&
              (pending ||
                (clip.cloud.revision ?? 0) < (clip.revision ?? 0)) && (
                <button
                  className="btn"
                  disabled={busy || updating}
                  onClick={() => void send()}
                >
                  {busy ? "Uploading update…" : "Update shared video"}
                </button>
              )}
            <button
              className="text-button danger"
              disabled={
                busy ||
                updating ||
                !sameWorkspace ||
                workspace?.reachable === false
              }
              onClick={() => void stop()}
            >
              Stop sharing
            </button>
            {clip.cloud.unverified && (
              <button
                className="btn small"
                disabled={busy}
                onClick={() => setRefresh((n) => n + 1)}
              >
                Check upload
              </button>
            )}
          </div>
        </>
      )}
      {!workspace && !connectionError && (
        <p role="status" className="share-note">
          <LoaderCircle className="spin" size={16} />
          Checking online sharing…
        </p>
      )}
      {connectionError && (
        <div className="share-note warn" role="alert">
          {connectionError}
          <button
            className="text-button"
            onClick={() => setRefresh((n) => n + 1)}
          >
            Try again
          </button>
        </div>
      )}
      {workspace?.error && (
        <p className="share-note warn" role="status">
          {workspace.error}
        </p>
      )}
      {workspace?.connected && !workspace.privacySupported && (
        <p className="share-note warn">
          Ask the workspace owner to update Relay before creating a link with
          privacy controls.
        </p>
      )}
      {workspace?.connected && localWorkspace && (
        <p className="share-note warn">
          This workspace address points to this computer. For other people to
          open a link, use an online HTTPS workspace address.
        </p>
      )}
      {workspace?.publicLinksAllowed === false && (
        <p className="small muted">
          This workspace allows sharing with signed-in members.
        </p>
      )}
      {needsPrivacy && canPublish && (
        <>
          <h3>
            {localWorkspace
              ? "Create a link on this computer"
              : "Create an online link"}
          </h3>
          <p className="share-note">
            Upload this finished video, title, description, transcript and
            preview to <strong>{target?.host}</strong>. Review the video and
            transcript for private information first.
          </p>
          <p className="small muted">
            The workspace administrator can access uploaded videos.
          </p>
          <div className="device-grid">
            <label className="field small">
              Who can watch
              <select
                value={audience}
                onChange={(e) => setAudience(e.target.value)}
                disabled={busy}
              >
                <option value="workspace">Workspace members</option>
                <option
                  value="password"
                  disabled={workspace?.publicLinksAllowed === false}
                >
                  People with the link and password
                </option>
                <option
                  value="link"
                  disabled={workspace?.publicLinksAllowed === false}
                >
                  Anyone with the link
                </option>
              </select>
            </label>
            <label className="field small">
              Link expires
              <select
                value={days}
                onChange={(e) => setDays(e.target.value)}
                disabled={busy}
              >
                <option value="1">In 1 day</option>
                <option value="7">In 7 days</option>
                <option value="30">In 30 days</option>
                <option value="0">Never</option>
              </select>
            </label>
          </div>
          <p className="small muted">
            {audience === "workspace"
              ? "Viewers sign in with their account for this workspace."
              : audience === "password"
                ? "Send the password separately from the link."
                : "People can forward this link, and anyone who receives it can watch."}
          </p>
          {audience === "password" && (
            <label className="field small">
              Video password
              <input
                type="password"
                aria-label="Video password"
                autoComplete="new-password"
                minLength={12}
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
              <span className="small muted">Use at least 12 characters.</span>
            </label>
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={download}
              disabled={busy}
              onChange={(e) => setDownload(e.target.checked)}
            />
            Show a download button
          </label>
          <p className="small muted">
            Viewers can make their own copies, including screen recordings.
          </p>
          <button
            className="btn primary"
            disabled={
              busy ||
              updating ||
              (workspace?.publicLinksAllowed === false &&
                audience !== "workspace") ||
              (audience === "password" && password.length < 12)
            }
            onClick={() => void send()}
          >
            <Link size={16} />
            {busy
              ? "Uploading…"
              : pending
                ? "Update video and create link"
                : "Create share link"}
          </button>
        </>
      )}
      {workspace &&
        (!workspace.connected || (clip.cloud && !sameWorkspace)) && (
          <div className="share-connect">
            {!clip.cloud && (
              <p>
                Download a video file to send now, or connect an online
                workspace to create a link.
              </p>
            )}
            <button className="text-button" onClick={onConnect}>
              {clip.cloud
                ? "Connect original workspace"
                : "Set up online sharing"}
            </button>
          </div>
        )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
