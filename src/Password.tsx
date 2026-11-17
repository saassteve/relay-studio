import { useEffect, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import { api } from "./types";

// Settings: a member changes the password they sign in with.
export function ChangePassword({
  email,
  notify,
  forgotten,
}: {
  email: string;
  notify: (message: string) => void;
  // What to do about a forgotten password, when the answer isn't "ask the owner".
  forgotten?: string;
}) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <>
      <h3 className="studio-section-title">
        <KeyRound size={17} />
        Your password
      </h3>
      <form
        className="change-password"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api("/api/password", {
              method: "PUT",
              body: JSON.stringify({ current, password: next }),
            });
            setCurrent("");
            setNext("");
            notify("Password changed. Your other devices were signed out.");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {/* Tells a password manager whose password this is. */}
        <input
          type="email"
          autoComplete="username"
          value={email}
          readOnly
          hidden
        />
        <div className="device-grid">
          <label>
            Current password
            <input
              type="password"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label>
            New password
            <input
              type="password"
              autoComplete="new-password"
              aria-describedby="new-password-hint"
              minLength={12}
              required
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </label>
        </div>
        <p className="studio-hint" id="new-password-hint">
          At least 12 characters. Changing it signs you out on your other
          devices.{forgotten ? ` ${forgotten}` : ""}
        </p>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <button className="btn small" disabled={busy}>
          <Check size={14} />
          {busy ? "Changing…" : "Change password"}
        </button>
      </form>
    </>
  );
}

// The page a reset link opens: the workspace owner creates the link for a
// member who forgot their password, and the member chooses a new one here.
export function PasswordResetPage({ token }: { token: string }) {
  const [member, setMember] = useState<{
      name: string;
      email: string;
    } | null>(null),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false);
  useEffect(() => {
    void api<typeof member>(`/api/password-resets/${token}`)
      .then(setMember)
      .catch((e) => setError(e.message));
  }, [token]);
  return (
    <main className="loading-page">
      <form
        className="dialog invitation-page"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await api(`/api/password-resets/${token}`, {
              method: "POST",
              body: JSON.stringify({ password }),
            });
            setDone(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>{done ? "Password changed" : "Choose a new password"}</h1>
        {done ? (
          <>
            <p className="muted">
              You’ve been signed out everywhere. Sign in with your new password.
            </p>
            <button
              type="button"
              className="btn primary"
              onClick={() => location.assign("/")}
            >
              Sign in
            </button>
          </>
        ) : (
          member && (
            <>
              <p className="muted">
                For {member.name} ({member.email}).
              </p>
              <input
                type="email"
                autoComplete="username"
                value={member.email}
                readOnly
                hidden
              />
              <div className="field-block">
                <label htmlFor="reset-password">New password</label>
                <input
                  id="reset-password"
                  aria-describedby="reset-password-hint"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  required
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <span className="small muted" id="reset-password-hint">
                  At least 12 characters.
                </span>
              </div>
              <button className="btn primary" disabled={busy}>
                {busy ? "Saving…" : "Save new password"}
              </button>
            </>
          )
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
