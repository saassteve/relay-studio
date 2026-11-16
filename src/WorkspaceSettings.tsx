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
}: {
  notify: (message: string) => void;
}) {
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
      <div className="eyebrow">YOUR PEOPLE. YOUR RULES.</div>
      <h2>Your workspace.</h2>
      <p className="muted small">
        {team?.member.name} · {team?.member.role} · {team?.member.email}
      </p>
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
                    if (confirm(`Remove ${member.name} from this workspace?`)) {
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
            <span className="small muted">{member.role}</span>
          )}
        </div>
      ))}
      {team?.member.role === "owner" && (
        <>
          <h3 className="studio-section-title">Invite a teammate</h3>
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
                aria-label="Invitation email"
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
          <h3 className="studio-section-title">
            <Link size={17} />
            Apps and agents
          </h3>
          <p className="studio-hint">
            Read recording context from your tools through the MCP endpoint.
            Integration tokens grant access to the workspace; keep them private.
          </p>
          <button
            className="btn small"
            onClick={() =>
              void action(async () =>
                setIntegration(await api("/api/integrations")),
              )
            }
          >
            <KeyRound size={14} />
            Manage integration access
          </button>
          {integration && (
            <div className="integration-details">
              <label>
                MCP URL
                <input
                  readOnly
                  value={`${location.origin}${integration.mcpPath}`}
                />
              </label>
              <label>
                Bearer token
                <input
                  readOnly
                  type={reveal ? "text" : "password"}
                  value={integration.token}
                />
              </label>
              <div className="actions">
                <button
                  className="text-button small"
                  onClick={() => setReveal(!reveal)}
                >
                  {reveal ? "Hide" : "Show"} token
                </button>
                <button
                  className="text-button small"
                  onClick={() => void copy(integration.token)}
                >
                  <Copy size={13} />
                  Copy token
                </button>
              </div>
              <p className="studio-hint">
                Webhook:{" "}
                {integration.webhookConfigured
                  ? "configured"
                  : "set RELAY_WEBHOOK_URL on the server"}
                . Local AI works without an API key. Optional Ollama uses
                OLLAMA_URL and OLLAMA_MODEL.
              </p>
            </div>
          )}
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
      <h3 className="studio-section-title">Desktop updates</h3>
      <button
        className="btn small"
        disabled={!window.relayDesktop?.checkForUpdates}
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
    <div className="loading-page">
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
        <div className="eyebrow">WELCOME TO THE WORKSPACE</div>
        <h2>A place for your ideas.</h2>
        {invite && (
          <>
            <p className="muted">
              Join as {invite.name} ({invite.email}) with the {invite.role}{" "}
              role.
            </p>
            <label className="field">
              Create your password
              <input
                aria-label="Create account password"
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
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
    </div>
  );
}
