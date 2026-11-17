import { confirmDialog } from "./Modal";
import { AISettings } from "./AISettings";
import { AppearanceSetting } from "./Appearance";
import { ChangePassword } from "./Password";
import { CloudSettings } from "./CloudSettings";
import { isLocal as localOnly } from "./local";
import {
  cachedPreferences,
  defaults,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./prefs";
import { Fragment, useEffect, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  Video,
  UserPlus,
} from "lucide-react";
import { api, type Member } from "./types";
interface Invitation {
  // What the list of waiting invitations knows one by. It is not the link.
  id: string;
  email: string;
  name: string;
  role: string;
  expires: number;
}
export function WorkspaceSettings({
  notify,
  focus = "",
}: {
  notify: (message: string) => void;
  focus?: string;
}) {
  // Opened from elsewhere (for example "Connect AI"): go straight to that part.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(
      () =>
        document
          .querySelector(`[data-settings="${focus}"]`)
          ?.scrollIntoView({ block: "start" }),
      150,
    );
    return () => clearTimeout(t);
  }, [focus]);
  const [team, setTeam] = useState<{
      member: Member;
      members: Member[];
      invitations: Invitation[];
      // Who looks after this member's password: nobody (a workspace without
      // passwords), the server's settings, or the member.
      password?: "none" | "server" | "own";
    } | null>(null),
    // The reset link just made for a member. It is shown once: the server only
    // keeps enough of it to recognise it later.
    [resetLink, setResetLink] = useState<{ id: string; url: string } | null>(
      null,
    ),
    // The invitation link just made. Like a reset link, it is shown once.
    [inviteLink, setInviteLink] = useState<{
      email: string;
      url: string;
    } | null>(null),
    [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [role, setRole] = useState("editor"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState<{
      sharing: { publicLinks: boolean; credit?: boolean };
    } | null>(null),
    [desktopNotifications, setDesktopNotifications] = useState(
      localStorage.getItem("relay-native-notifications") === "true",
    );
  const load = async () => {
    setTeam(await api("/api/team"));
    setSettings(await api("/api/settings"));
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("Copied");
    } catch {
      setError("Clipboard access is unavailable. Select the value to copy it.");
    }
  };
  // Makes an invitation link, or a new one for someone already invited, which
  // replaces the link they were sent before.
  const invite = async (who: { email: string; name: string; role: string }) => {
    const made = await api<{ token: string }>("/api/team/invitations", {
      method: "POST",
      body: JSON.stringify({
        email: who.email,
        name: who.name,
        role: who.role,
      }),
    });
    const url = `${location.origin}/invite/${made.token}`;
    setInviteLink({ email: who.email, url });
    await copy(url);
    await load();
  };
  // Relay on someone's own computer, with no passwords, has one person in it:
  // there is nobody to list or invite.
  const alone = localOnly && team?.password === "none";
  return (
    <div className="workspace-settings">
      <h2>Settings</h2>
      <RecordingPreferences />
      <AppearanceSetting />
      {!alone && (
        <h3 className="studio-section-title">
          <Users size={17} />
          Members
        </h3>
      )}
      {team?.members
        .filter(() => !alone)
        .map((member) => (
          <Fragment key={member.id}>
            <div className="member-row">
              <span className="avatar">{member.name[0]}</span>
              <div>
                <strong>{member.name}</strong>
                <small>{member.email}</small>
              </div>
              {team.member.role === "owner" && member.role !== "owner" ? (
                <>
                  {team.password !== "none" && (
                    <button
                      className="icon-button"
                      aria-label={`Create a password reset link for ${member.email}`}
                      title="Create a password reset link"
                      onClick={() =>
                        void action(async () => {
                          const { token } = await api<{ token: string }>(
                            `/api/team/${member.id}/password-reset`,
                            { method: "POST" },
                          );
                          const url = `${location.origin}/reset/${token}`;
                          setResetLink({ id: member.id, url });
                          await copy(url);
                        })
                      }
                    >
                      <KeyRound size={15} />
                    </button>
                  )}
                  <select
                    aria-label={`Role for ${member.email}`}
                    value={member.role}
                    onChange={(e) =>
                      void action(async () => {
                        await api(`/api/team/${member.id}`, {
                          method: "PATCH",
                          body: JSON.stringify({ role: e.target.value }),
                        });
                        await load();
                      })
                    }
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    className="icon-button danger"
                    aria-label={`Remove ${member.email}`}
                    onClick={() =>
                      void action(async () => {
                        if (
                          await confirmDialog({
                            title: `Remove ${member.name}?`,
                            body: "They will lose access to this workspace’s videos.",
                            confirm: "Remove",
                            destructive: true,
                          })
                        ) {
                          await api(`/api/team/${member.id}`, {
                            method: "DELETE",
                          });
                          await load();
                        }
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </>
              ) : (
                <span className="role-pill">
                  {member.role[0].toUpperCase() + member.role.slice(1)}
                </span>
              )}
            </div>
            {resetLink?.id === member.id && (
              <div className="reset-link">
                <div className="invite-row">
                  <input
                    readOnly
                    aria-label={`Password reset link for ${member.email}`}
                    value={resetLink.url}
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    className="text-button small"
                    onClick={() => void copy(resetLink.url)}
                  >
                    <Copy size={13} />
                    Copy
                  </button>
                </div>
                <p className="studio-hint">
                  Send this link to {member.name} yourself. It lets them choose
                  a new password, works once and expires in 24 hours. It won’t
                  be shown again.
                </p>
              </div>
            )}
          </Fragment>
        ))}
      {team?.password && team.password !== "none" && (
        <ChangePassword
          email={team.member.email}
          notify={notify}
          forgotten={
            team.password === "server"
              ? "If you ever forget it, set a new ADMIN_PASSWORD on the server and restart Relay."
              : undefined
          }
        />
      )}
      {team?.member.role === "owner" && !alone && (
        <>
          <h3 className="studio-section-title">
            <UserPlus size={17} />
            Invite a teammate
          </h3>
          <div className="device-grid">
            <label>
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sam"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="sam@example.com"
              />
            </label>
          </div>
          <div className="actions">
            <select
              aria-label="Invitation role"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              <option value="editor">Editor · record and edit</option>
              <option value="viewer">Viewer · browse only</option>
            </select>
            <button
              className="btn small"
              disabled={busy || !email}
              onClick={() =>
                void action(async () => {
                  await invite({ email, name: name || email, role });
                  setEmail("");
                  setName("");
                })
              }
            >
              <Plus size={14} />
              Create invite link
            </button>
          </div>
          <p className="studio-hint">
            Copy and send the invitation yourself. Links expire in seven days;
            no email is sent automatically.
          </p>
          {inviteLink && (
            <div className="reset-link">
              <div className="invite-row">
                <input
                  readOnly
                  aria-label={`Invitation link for ${inviteLink.email}`}
                  value={inviteLink.url}
                  onFocus={(e) => e.target.select()}
                />
                <button
                  className="text-button small"
                  onClick={() => void copy(inviteLink.url)}
                >
                  <Copy size={13} />
                  Copy
                </button>
              </div>
              <p className="studio-hint">
                Send this link to {inviteLink.email} yourself. Relay doesn’t
                keep it, so it won’t be shown again: if it gets lost, make a new
                one.
              </p>
            </div>
          )}
          {team.invitations.map((i) => (
            <div className="invite-row" key={i.id}>
              <span>
                {i.email} · {i.role}
              </span>
              <button
                className="text-button small"
                title="Replaces the link sent before"
                disabled={busy}
                onClick={() => void action(() => invite(i))}
              >
                <Copy size={13} />
                New link
              </button>
              <button
                className="icon-button danger"
                aria-label={`Revoke invitation for ${i.email}`}
                onClick={() =>
                  void action(async () => {
                    await api(`/api/team/invitations/${i.id}`, {
                      method: "DELETE",
                    });
                    if (inviteLink?.email === i.email) setInviteLink(null);
                    await load();
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </>
      )}
      {team?.member.role === "owner" && (
        <>
          <h3 className="studio-section-title">
            <ShieldCheck size={17} />
            {alone ? "Sharing" : "Sharing policy"}
          </h3>
          <label className="check-label" hidden={alone}>
            <input
              type="checkbox"
              checked={settings?.sharing.publicLinks !== false}
              onChange={(e) =>
                setSettings({
                  sharing: {
                    ...settings?.sharing,
                    publicLinks: e.target.checked,
                  },
                })
              }
            />
            Editors may create public share links
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={settings?.sharing.credit !== false}
              onChange={(e) =>
                setSettings({
                  sharing: {
                    publicLinks: settings?.sharing.publicLinks !== false,
                    credit: e.target.checked,
                  },
                })
              }
            />
            Show “Made with Relay” on shared pages
          </label>
          <button
            className="btn small"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                await api("/api/settings", {
                  method: "PUT",
                  body: JSON.stringify(settings),
                });
                notify("Workspace policy saved");
              })
            }
          >
            <Check size={14} />
            {alone ? "Save" : "Save policy"}
          </button>
          <div data-settings="cloud">
            <CloudSettings notify={notify} />
          </div>
          <div data-settings="ai">
            <AISettings notify={notify} />
          </div>
        </>
      )}
      {window.relayDesktop && (
        <>
          <h3 className="studio-section-title">Notifications</h3>
          <label className="check-label">
            <input
              type="checkbox"
              checked={desktopNotifications}
              onChange={(e) => {
                setDesktopNotifications(e.target.checked);
                localStorage.setItem(
                  "relay-native-notifications",
                  String(e.target.checked),
                );
              }}
            />
            Desktop notifications when a recording is ready
          </label>
        </>
      )}
      {window.relayDesktop?.checkForUpdates && (
        <DesktopUpdates notify={notify} />
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <p className="muted small">
          <LoaderCircle size={14} className="spin" />
          Saving…
        </p>
      )}
    </div>
  );
}
export function InvitationPage({ token }: { token: string }) {
  const [invite, setInvite] = useState<{
      name: string;
      email: string;
      role: string;
    } | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<typeof invite>(`/api/invitations/${token}`)
      .then(setInvite)
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <main className="loading-page">
      <form
        className="dialog invitation-page"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/api/invitations/${token}/accept`, {
              method: "POST",
              body: JSON.stringify({ password }),
            });
            location.assign("/");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>Join the workspace</h1>
        {invite && (
          <>
            <p className="muted">
              Join as {invite.name} ({invite.email}) with the {invite.role}{" "}
              role.
            </p>
            <div className="field-block">
              <label htmlFor="invite-password">Create your password</label>
              <input
                id="invite-password"
                aria-describedby="invite-password-hint"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="small muted" id="invite-password-hint">
                At least 12 characters.
              </span>
            </div>
            <button className="btn primary" disabled={busy}>
              {busy ? "Joining…" : "Join workspace"}
            </button>
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
      </form>
    </main>
  );
}

// The choices made during setup, changeable at any time.
function RecordingPreferences() {
  const [p, setP] = useState<Preferences>(cachedPreferences());
  useEffect(() => {
    void loadPreferences(true).then(setP);
  }, []);
  const set = (next: Partial<Preferences>) => {
    setP((old) => ({ ...old, ...next }));
    void savePreferences(next);
  };
  const v = <K extends keyof typeof defaults>(k: K) =>
    (p[k as keyof Preferences] ?? defaults[k]) as (typeof defaults)[K];
  const desktop = Boolean(window.relayDesktop);
  return (
    <>
      <h3 className="studio-section-title">
        <Video size={17} />
        Recording
      </h3>
      <div className="settings-grid">
        <label>
          When I finish recording
          <select
            value={v("afterRecording")}
            onChange={(e) =>
              set({
                afterRecording: e.target.value as Preferences["afterRecording"],
              })
            }
          >
            {!localOnly && (
              <option value="copy-link">
                Copy a share link and open the editor
              </option>
            )}
            <option value="open-editor">Just open the editor</option>
          </select>
        </label>
        <label>
          Countdown before recording
          <select
            value={v("countdown")}
            onChange={(e) =>
              set({
                countdown: Number(e.target.value) as Preferences["countdown"],
              })
            }
          >
            <option value={0}>None</option>
            <option value={3}>3 seconds</option>
            <option value={5}>5 seconds</option>
          </select>
        </label>
        <label>
          Video quality
          <select
            value={v("quality")}
            onChange={(e) =>
              set({ quality: Number(e.target.value) as Preferences["quality"] })
            }
          >
            <option value={1280}>720p</option>
            <option value={1920}>1080p</option>
            <option value={3840}>4K</option>
          </select>
        </label>
      </div>
      <div className="settings-checks">
        <label className="check-label">
          <input
            type="checkbox"
            checked={v("keyShortcuts")}
            onChange={(e) => set({ keyShortcuts: e.target.checked })}
          />
          Press R to start a new recording
        </label>
      </div>
      {desktop && (
        <div className="settings-checks">
          <label className="check-label">
            <input
              type="checkbox"
              checked={v("autoZoom")}
              onChange={(e) => set({ autoZoom: e.target.checked })}
            />
            Zoom in automatically where I point and pause
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={v("bubble")}
              onChange={(e) => set({ bubble: e.target.checked })}
            />
            Show my camera bubble on screen while recording
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={v("hideWindow")}
              onChange={(e) => set({ hideWindow: e.target.checked })}
            />
            Hide Relay while recording
          </label>
        </div>
      )}
    </>
  );
}
// The Mac app's own updates: what it is doing about them, and whether it should
// look for them by itself. An older app has no update state and only checks.
function DesktopUpdates({ notify }: { notify: (message: string) => void }) {
  const desktop = window.relayDesktop!;
  const [update, setUpdate] = useState<
      import("./types").DesktopUpdateState | null
    >(null),
    [waiting, setWaiting] = useState(false);
  useEffect(() => {
    let current = true;
    void desktop
      .updateState?.()
      .then((state) => {
        if (current) setUpdate(state);
      })
      .catch(() => {});
    const stop = desktop.onUpdateState?.(setUpdate);
    return () => {
      current = false;
      stop?.();
    };
  }, [desktop]);
  const run = async (task: () => Promise<void>) => {
    setWaiting(true);
    try {
      await task();
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setWaiting(false);
    }
  };
  const latest = update?.latest ? `Relay ${update.latest}` : "the update";
  const status = !update
    ? ""
    : update.status === "ready"
      ? `${latest} is ready. Restart to update.`
      : update.status === "downloading"
        ? `Downloading ${latest} (${update.percent ?? 0}%)`
        : update.status === "preparing"
          ? `Getting ${latest} ready…`
          : update.status === "checking"
            ? "Checking for updates…"
            : update.status === "current"
              ? "Relay is up to date."
              : update.status === "failed"
                ? update.latest
                  ? `Couldn’t install ${latest} automatically.`
                  : "Couldn’t check for updates."
                : update.latest
                  ? `${latest} downloads once the recording has finished.`
                  : "";
  const working =
    waiting ||
    ["checking", "downloading", "preparing"].includes(update?.status || "");
  return (
    <>
      <h3 className="studio-section-title">Desktop updates</h3>
      {update && (
        <p
          className="studio-hint"
          role="status"
          data-update-status={update.status}
        >
          You have Relay {update.version}.{status && ` ${status}`}
        </p>
      )}
      {update?.mode === "auto" && (
        <>
          <label className="check-label">
            <input
              type="checkbox"
              checked={update.automatic}
              onChange={(e) =>
                void run(async () =>
                  setUpdate(
                    await desktop.setAutomaticUpdates!(e.target.checked),
                  ),
                )
              }
            />
            Keep Relay up to date automatically
          </label>
          <p className="studio-hint">
            Relay looks on GitHub for a new version when it opens and once a
            day, downloads it in the background and installs it when you restart
            or quit. It never interrupts a recording, and nothing about you or
            your library is sent. With this off, Relay only looks when you click
            Check now.
          </p>
        </>
      )}
      {update?.misplaced && (
        <p className="studio-hint">
          Relay can’t update itself from where it is now. Open it from your
          Applications folder and it will keep itself up to date.
        </p>
      )}
      <div className="actions">
        {update?.status === "ready" && (
          <button
            className="btn small"
            disabled={waiting}
            onClick={() =>
              void run(async () => {
                const result = await desktop.restartToUpdate!();
                if (!result.ok) notify(result.status);
              })
            }
          >
            Restart to update
          </button>
        )}
        <button
          className="btn small"
          disabled={working}
          onClick={() =>
            void run(async () => {
              const result = await desktop.checkForUpdates!();
              notify(result.status);
            })
          }
        >
          <RefreshCw size={14} />
          Check now
        </button>
      </div>
    </>
  );
}
