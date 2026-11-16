import { confirmDialog } from "./Modal";
import { AISettings } from "./AISettings";
import {
  cachedPreferences,
  defaults,
  loadPreferences,
  savePreferences,
  type Preferences,
} from "./prefs";
import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  KeyRound,
  Link,
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
  token: string;
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
    } | null>(null),
    [email, setEmail] = useState(""),
    [name, setName] = useState(""),
    [role, setRole] = useState("editor"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState<{
      sharing: { publicLinks: boolean };
    } | null>(null),
    [integration, setIntegration] = useState<{
      token: string;
      mcpPath: string;
      webhookConfigured: boolean;
    } | null>(null),
    [reveal, setReveal] = useState(false),
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
  return (
    <div className="workspace-settings">
      <h2>Settings</h2>
      <RecordingPreferences />
      <h3 className="studio-section-title">
        <Users size={17} />
        Members
      </h3>
      {team?.members.map((member) => (
        <div className="member-row" key={member.id}>
          <span className="avatar">{member.name[0]}</span>
          <div>
            <strong>{member.name}</strong>
            <small>{member.email}</small>
          </div>
          {team.member.role === "owner" && member.role !== "owner" ? (
            <>
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
                      await api(`/api/team/${member.id}`, { method: "DELETE" });
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
      ))}
      {team?.member.role === "owner" && (
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
                  const invitation = await api<Invitation>(
                    "/api/team/invitations",
                    {
                      method: "POST",
                      body: JSON.stringify({
                        email,
                        name: name || email,
                        role,
                      }),
                    },
                  );
                  await copy(`${location.origin}/invite/${invitation.token}`);
                  setEmail("");
                  setName("");
                  await load();
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
          {team.invitations.map((i) => (
            <div className="invite-row" key={i.token}>
              <span>
                {i.email} · {i.role}
              </span>
              <button
                className="text-button small"
                onClick={() =>
                  void copy(`${location.origin}/invite/${i.token}`)
                }
              >
                <Copy size={13} />
                Copy
              </button>
              <button
                className="icon-button danger"
                aria-label={`Revoke invitation for ${i.email}`}
                onClick={() =>
                  void action(async () => {
                    await api(`/api/team/invitations/${i.token}`, {
                      method: "DELETE",
                    });
                    await load();
                  })
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <h3 className="studio-section-title">
            <ShieldCheck size={17} />
            Sharing policy
          </h3>
          <label className="check-label">
            <input
              type="checkbox"
              checked={settings?.sharing.publicLinks !== false}
              onChange={(e) =>
                setSettings({ sharing: { publicLinks: e.target.checked } })
              }
            />
            Editors may create public share links
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
            Save policy
          </button>
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
        <>
          <h3 className="studio-section-title">Desktop updates</h3>
          <button
            className="btn small"
            onClick={() =>
              void action(async () => {
                const result = await window.relayDesktop!.checkForUpdates!();
                notify(result.status);
              })
            }
          >
            <RefreshCw size={14} />
            Check for updates
          </button>
        </>
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

const localOnly = ["127.0.0.1", "localhost"].includes(location.hostname);
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
