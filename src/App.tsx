import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Code2,
  Folder,
  Grid2X2,
  HardDrive,
  HelpCircle,
  Link,
  List,
  LoaderCircle,
  Lock,
  LogOut,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Star,
  Upload,
  X,
} from "lucide-react";
import { Recorder } from "./Recorder";
import { WorkspaceSettings, InvitationPage } from "./WorkspaceSettings";
import { RecoveryCenter } from "./RecoveryCenter";
import { startDraftSync } from "./drafts";
import { Editor } from "./Editor";
import { Onboarding, type OnboardingExit } from "./Onboarding";
import { loadPreferences, type Preferences } from "./prefs";
import { createDemo, inspectVideo } from "./media";
import { api, bytes, clock, type Clip } from "./types";
function Logo() {
  return (
    <span className="wordmark">
      <svg viewBox="0 0 34 36" aria-hidden="true">
        <path d="M3 3h13a15 15 0 0 1 0 30H3V3Z" fill="currentColor" />
        <path d="m12 11 12 7-12 7Z" fill="#f8f9f3" />
      </svg>
      relay
    </span>
  );
}
export default function App() {
  const [path, setPath] = useState(location.pathname),
    [clips, setClips] = useState<Clip[]>([]),
    [active, setActive] = useState<Clip | null>(null),
    [session, setSession] = useState<{
      unlocked: boolean;
      protected: boolean;
      member?: { role: string; name?: string };
    } | null>(null),
    [prefs, setPrefs] = useState<Preferences | null>(null),
    [onboarding, setOnboarding] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [record, setRecord] = useState(false),
    [section, setSection] = useState("library"),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("recent"),
    [layout, setLayout] = useState("grid"),
    [toasts, setToasts] = useState<{ id: number; text: string }[]>([]),
    [dialog, setDialog] = useState(""),
    [busy, setBusy] = useState(""),
    [mobile, setMobile] = useState(false),
    [password, setPassword] = useState(""),
    [help, setHelp] = useState(false),
    [shareGate, setShareGate] = useState<{
      requiresPassword?: boolean;
      requiresLogin?: boolean;
    } | null>(null),
    [viewerPassword, setViewerPassword] = useState(""),
    [viewerEmail, setViewerEmail] = useState(""),
    [loginEmail, setLoginEmail] = useState("");
  const input = useRef<HTMLInputElement>(null),
    search = useRef<HTMLInputElement>(null),
    toastId = useRef(0);
  const embedded = path.startsWith("/embed/");
  const token = embedded
    ? path.slice(7)
    : path.startsWith("/s/")
      ? path.slice(3)
      : undefined;
  const navigate = useCallback((p: string) => {
    history.pushState({}, "", p);
    setPath(p);
    window.scrollTo(0, 0);
  }, []);
  // Toasts stack so a background event never hides the confirmation you just asked for.
  const notify = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((all) =>
      [...all.filter((t) => t.text !== text), { id, text }].slice(-3),
    );
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 4000);
  }, []);
  const toastStack = toasts.length > 0 && (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div className="toast" role="status" key={t.id}>
          <Check size={17} />
          {t.text}
        </div>
      ))}
    </div>
  );
  const canEdit = session?.member?.role !== "viewer";
  function requestRecording() {
    if (!canEdit)
      notify(
        "Your role can review recordings. Ask an editor to create a new one.",
      );
    else setRecord(true);
  }
  const refresh = useCallback(async () => {
    const data = await api<Clip[]>("/api/videos");
    setClips(data);
  }, []);
  useEffect(() => {
    if (!session?.unlocked || token) return;
    return startDraftSync(() => {
      notify("A recording is ready in your library.");
      if (localStorage.getItem("relay-native-notifications") === "true")
        window.relayDesktop?.notify?.(
          "Your recording is ready in your library.",
        );
      void refresh().catch(() => {});
    });
  }, [session?.unlocked, token, notify, refresh]);
  useEffect(() => {
    if (!session?.unlocked || token || path.startsWith("/invite/")) return;
    let cancelled = false;
    void loadPreferences(true).then((p) => {
      if (cancelled) return;
      setPrefs(p);
      if (!p.onboarded && session.member?.role !== "viewer") setOnboarding(true);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.unlocked, token]);
  useEffect(
    () =>
      window.relayDesktop?.onControl?.((action) => {
        if (action === "onboarding") void openOnboarding();
      }),
    [],
  );
  async function openOnboarding() {
    setPrefs(await loadPreferences(true));
    setDialog("");
    setHelp(false);
    setOnboarding(true);
  }
  const finishOnboarding = (exit: OnboardingExit) => {
    setOnboarding(false);
    void loadPreferences(true).then(setPrefs);
    if (exit === "record") requestRecording();
    else if (exit === "sample") void demo();
  };
  const memberName = session?.member?.name || "";
  const initial =
    memberName && memberName !== "Workspace owner"
      ? memberName.trim()[0].toUpperCase()
      : "R";
  useEffect(() => {
    const pop = () => setPath(location.pathname);
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    setLoading(true);
    setError("");
    setShareGate(null);
    setActive(null);
    let cancelled = false;
    (async () => {
      try {
        if (token) {
          const v = await api<Clip>(`/api/share/${token}`);
          if (!cancelled) setActive(v);
        } else {
          const s = await api<{
            unlocked: boolean;
            protected: boolean;
            member?: { role: string; name?: string };
          }>("/api/session");
          if (cancelled) return;
          setSession(s);
          if (s.unlocked) {
            await refresh();
            if (path.startsWith("/video/")) {
              const v = await api<Clip>(`/api/videos/${path.slice(7)}`);
              if (!cancelled) setActive(v);
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          if (token)
            setShareGate(
              e as { requiresPassword?: boolean; requiresLogin?: boolean },
            );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, token, refresh]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if ((e.target as HTMLElement).closest("input,textarea,select")) return;
      if (
        e.key.toLowerCase() === "r" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !onboarding &&
        !token &&
        session?.unlocked &&
        !record
      )
        requestRecording();
      if (e.key === "Escape") {
        setDialog("");
        setHelp(false);
        setMobile(false);
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [record, token, session, onboarding]);
  useEffect(
    () => window.relayDesktop?.onRecord(() => requestRecording()),
    [canEdit],
  );
  const open = (c: Clip) => navigate(`/video/${c.id}`);
  useEffect(() => {
    const update = () => void refresh().catch(() => {});
    addEventListener("relay:library", update);
    return () => removeEventListener("relay:library", update);
  }, [refresh]);
  const saved = (c: Clip, copied = false) => {
    setRecord(false);
    setClips((old) => [c, ...old.filter((v) => v.id !== c.id)]);
    open(c);
    notify(
      copied
        ? "Link copied. Paste it anywhere while you polish."
        : "Recording saved. Make it yours.",
    );
  };
  const update = (c: Clip) => {
    setClips((old) =>
      old.some((v) => v.id === c.id)
        ? old.map((v) => (v.id === c.id ? c : v))
        : [c, ...old],
    );
    if (active?.id === c.id) setActive(c);
  };
  const upload = async (file: File) => {
    if (!canEdit) {
      notify(
        "Your role can review recordings. Ask an editor to import footage.",
      );
      return;
    }
    if (file.name.endsWith(".relay")) {
      setBusy("Bringing your editable project in…");
      try {
        const form = new FormData();
        form.append("project", file);
        saved(
          await api<Clip>("/api/projects/import", {
            method: "POST",
            body: form,
          }),
        );
        notify("Editable project imported");
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy("");
        if (input.current) input.current.value = "";
      }
      return;
    }

    setBusy("Bringing your video in…");
    setError("");
    try {
      const info = await inspectVideo(file);
      const form = new FormData();
      form.append("video", file);
      form.append("title", file.name.replace(/\.[^.]+$/, ""));
      form.append("duration", String(info.duration));
      form.append("thumbnail", info.thumbnail);
      saved(await api<Clip>("/api/videos", { method: "POST", body: form }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      if (input.current) input.current.value = "";
    }
  };
  const demo = async () => {
    if (!canEdit) {
      notify(
        "Your role can review recordings. Ask an editor to create a sample.",
      );
      return;
    }
    setBusy("Making a little something to explore…");
    setError("");
    try {
      const blob = await createDemo();
      const info = await inspectVideo(blob, 6);
      const form = new FormData();
      form.append("video", blob, "welcome.webm");
      form.append("title", "A little less meeting. A lot more doing.");
      form.append("duration", "6");
      form.append("thumbnail", info.thumbnail);
      saved(await api<Clip>("/api/videos", { method: "POST", body: form }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const folders = [...new Set(clips.map((c) => c.folder).filter(Boolean))];
  const filtered = clips
    .filter(
      (c) =>
        (section === "starred"
          ? c.starred
          : section === "shared"
            ? c.token
            : section.startsWith("folder:")
              ? c.folder === section.slice(7)
              : true) &&
        `${c.title} ${c.description} ${c.folder} ${(c.transcript || []).map((w) => w.text).join(" ")}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "oldest"
        ? a.created.localeCompare(b.created)
        : sort === "name"
          ? a.title.localeCompare(b.title)
          : sort === "views"
            ? b.views - a.views
            : b.created.localeCompare(a.created),
    );
  const sectionTitle =
    section === "starred"
      ? "The good stuff."
      : section === "shared"
        ? "Out in the world."
        : section.startsWith("folder:")
          ? section.slice(7)
          : "Your video library";
  const changeSection = (s: string) => {
    setSection(s);
    setMobile(false);
    setQuery("");
    if (path !== "/") navigate("/");
  };
  const recorderModal = record && session?.member?.role !== "viewer" && (
    <div className="dialog-backdrop recorder-backdrop">
      <section
        className="dialog recorder-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="New recording"
      >
        <button
          className="dialog-close icon-button"
          aria-label="Close recorder"
          onClick={() => setRecord(false)}
        >
          <X size={21} />
        </button>
        <Recorder onClose={() => setRecord(false)} onSaved={saved} />
      </section>
    </div>
  );
  if (path.startsWith("/invite/"))
    return <InvitationPage token={path.slice(8)} />;
  if (active)
    return (
      <>
        <Editor
          key={active?.id || token}
          initial={active!}
          token={token}
          embedded={embedded}
          readOnly={!token && session?.member?.role === "viewer"}
          onBack={() => navigate("/")}
          onUpdate={update}
          onDelete={() => {
            if (active) setClips(clips.filter((c) => c.id !== active.id));
            navigate("/");
            notify("Video deleted");
          }}
          notify={notify}
        />
        {recorderModal}
        {toastStack}
      </>
    );
  if (token)
    return (
      <div className="loading-page">
        {loading ? (
          <LoaderCircle className="spin" />
        ) : (
          <>
            <Logo />
            {shareGate?.requiresPassword || shareGate?.requiresLogin ? (
              <form
                className="dialog viewer-gate"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setError("");
                  try {
                    if (shareGate.requiresLogin)
                      await api("/api/session", {
                        method: "POST",
                        body: JSON.stringify({
                          email: viewerEmail,
                          password: viewerPassword,
                        }),
                      });
                    else
                      await api(`/api/share/${token}/unlock`, {
                        method: "POST",
                        body: JSON.stringify({ password: viewerPassword }),
                      });
                    location.reload();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                <h2>
                  {shareGate.requiresLogin
                    ? "A video for your workspace."
                    : "A little privacy."}
                </h2>
                <p className="muted">
                  {shareGate.requiresLogin
                    ? "Sign in with your invited workspace account."
                    : "Enter the video password to watch."}
                </p>
                {shareGate.requiresLogin && (
                  <label className="field">
                    Email
                    <input
                      type="email"
                      required
                      value={viewerEmail}
                      onChange={(e) => setViewerEmail(e.target.value)}
                      autoComplete="username"
                    />
                  </label>
                )}
                <label className="field">
                  Password
                  <input
                    aria-label="Watch password"
                    type="password"
                    required
                    value={viewerPassword}
                    onChange={(e) => setViewerPassword(e.target.value)}
                    autoComplete="current-password"
                  />
                </label>
                {error && (
                  <div className="error" role="alert">
                    {error}
                  </div>
                )}
                <button className="btn primary">
                  Watch video
                  <ArrowRight size={15} />
                </button>
              </form>
            ) : (
              <>
                <h2>That link has left the chat.</h2>
                <p>{error}</p>
                <button className="btn" onClick={() => navigate("/")}>
                  Go to Relay
                </button>
              </>
            )}
          </>
        )}
      </div>
    );
  if (session && !session.unlocked)
    return (
      <div className="login-page">
        <div className="login-art">
          <Logo />
          <h1>
            Your ideas.
            <br />
            Your space.
          </h1>
          <div className="login-orbit">
            <PlayMark />
          </div>
          <p>
            A little less meeting.
            <br />A lot more doing.
          </p>
        </div>
        <form
          className="login-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              const signedIn = await api<{ member: { role: string } }>(
                "/api/session",
                {
                  method: "POST",
                  body: JSON.stringify({
                    password,
                    ...(loginEmail ? { email: loginEmail } : {}),
                  }),
                },
              );
              setSession({
                ...session,
                unlocked: true,
                member: signedIn.member,
              });
              await refresh();
              navigate("/");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          <Lock size={26} />
          <h2>Welcome back.</h2>
          <p className="muted">Unlock your Relay workspace.</p>
          <label className="field">
            Email
            <input
              type="email"
              aria-label="Workspace email"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
              placeholder="Owner may leave blank"
              autoComplete="username"
            />
          </label>
          <label className="field">
            Workspace password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          <button className="btn primary">
            Let’s go
            <ArrowRight size={17} />
          </button>
        </form>
      </div>
    );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobile ? "is-open" : ""}`}>
        <button
          className="brand-button"
          aria-label="Relay home"
          onClick={() => changeSection("library")}
        >
          <Logo />
        </button>
        <button
          className="workspace-picker"
          onClick={() => setDialog("workspace")}
        >
          <span className="workspace-avatar">
            {initial}
            <span />
          </span>
          <span>
            <strong>
              {memberName && memberName !== "Workspace owner"
                ? `${memberName.split(" ")[0]}’s workspace`
                : "My workspace"}
            </strong>
            <small>{window.relayDesktop ? "On this Mac" : "Personal space"}</small>
          </span>
          <ChevronDown size={15} />
        </button>
        <button className="new-recording" onClick={() => requestRecording()}>
          <span className="record-dot" />
          New recording<kbd>R</kbd>
        </button>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {(
            [
              ["library", "My library", Clapperboard],
              ["starred", "Starred", Star],
              ["shared", "Shared links", Link],
            ] as const
          ).map(([s, label, Icon]) => (
            <button
              key={s as string}
              className={section === s ? "active" : ""}
              onClick={() => changeSection(s as string)}
            >
              <Icon size={18} />
              <span>{label as string}</span>
              {s === "library" && (
                <span className="nav-count">{clips.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label collection-label">
          COLLECTIONS{" "}
          <button
            className="icon-button"
            aria-label="Create collection"
            onClick={() => setDialog("collection")}
          >
            <Plus size={15} />
          </button>
        </div>
        <nav className="folders">
          {folders.length ? (
            folders.map((f) => (
              <button
                key={f}
                className={section === `folder:${f}` ? "active" : ""}
                onClick={() => changeSection(`folder:${f}`)}
              >
                <Folder size={17} />
                <span>{f}</span>
              </button>
            ))
          ) : (
            <button
              className="empty-folder"
              onClick={() => setDialog("collection")}
            >
              <Folder size={17} />
              <span>Make room for ideas</span>
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="ownership-card">
            <div>
              <Code2 size={18} />
              <span>Open source. All yours.</span>
            </div>
            <p>
              Great ideas deserve
              <br />a space of their own.
            </p>
            <button onClick={() => setDialog("about")}>
              Meet Relay
              <ArrowUpRight size={15} />
            </button>
          </div>
          <button
            className="sidebar-link"
            onClick={() => setDialog("settings")}
          >
            <Settings size={17} />
            Workspace settings
          </button>
          <button
            className="profile-row"
            onClick={() => setDialog("workspace")}
          >
            <span className="avatar owner">{initial}</span>
            <span>
              <strong>{memberName || "Your workspace"}</strong>
              <small>Make yourself at home.</small>
            </span>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      {mobile && (
        <div className="mobile-scrim" onClick={() => setMobile(false)} />
      )}
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobile(true)}
          >
            <Menu size={21} />
          </button>
          <div className="breadcrumb">
            Workspace
            <ChevronRight size={14} />
            <span>
              {section === "library"
                ? "My library"
                : section === "starred"
                  ? "Starred"
                  : section === "shared"
                    ? "Shared links"
                    : section.slice(7)}
            </span>
          </div>
          <div className="topbar-right">
            <RecoveryCenter onOpen={open} notify={notify} />
            <span className="local-badge">
              <span className="tiny-dot" />
              {window.relayDesktop
                ? "Desktop studio"
                : "Your own little corner"}
            </span>
            <button
              className="icon-button"
              aria-label="Help"
              onClick={() => setHelp(true)}
            >
              <HelpCircle size={19} />
            </button>
            <button
              className="avatar owner"
              aria-label="Your workspace"
              onClick={() => setDialog("workspace")}
            >
              {initial}
            </button>
          </div>
        </header>
        <main className="library-main">
          <div className="page-intro">
            <div>
              <div className="eyebrow">LESS MEETING. MORE MEANING.</div>
              <h1>
                {section === "library" ? "Ideas worth sharing." : sectionTitle}
              </h1>
              <p>Show the work. Share the thinking. Keep things moving.</p>
            </div>
            <button
              className="btn import-btn"
              onClick={() => input.current?.click()}
            >
              <Upload size={16} />
              Upload video
            </button>
          </div>
          {section === "library" && !query && (
            <section className="hero">
              <div className="hero-copy">
                <span className="hero-tag">
                  <span className="tiny-dot" />A LITTLE VIDEO GOES A LONG WAY
                </span>
                <h2>
                  Big ideas.
                  <br />
                  <em>Small videos.</em>
                </h2>
                <p>
                  Skip the calendar invite.
                  <br />
                  Put a little of yourself into the message.
                </p>
                <button className="hero-cta" onClick={() => requestRecording()}>
                  <span className="record-dot" />
                  Let’s record something
                  <ArrowUpRight size={18} />
                </button>
                <span className="hero-footnote">
                  Your screen. Your voice. No big production.
                </span>
              </div>
              <div className="hero-illustration" aria-hidden="true">
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="illus-spark">✳</div>
                <div className="floating-note note-top">
                  <span className="mini-avatar">S</span>
                  <span>
                    A quick thought…
                    <i />
                  </span>
                  <span>↗</span>
                </div>
                <div className="video-paper">
                  <div className="paper-top">
                    <span />
                    <span />
                    <span />
                    <i>relay / a good idea</i>
                  </div>
                  <div className="paper-content">
                    <div className="paper-pill">THE NEXT BIG THING</div>
                    <span>
                      Less talking
                      <br />
                      about the work.
                      <br />
                      <b>More doing.</b>
                    </span>
                    <div className="paper-lines">
                      <i />
                      <i />
                    </div>
                    <button tabIndex={-1}>
                      <PlayMark />
                    </button>
                  </div>
                  <div className="paper-progress">
                    <i />
                    <span>00:42 / 01:20</span>
                  </div>
                </div>
                <div className="floating-note note-bottom">
                  <span>💡</span>
                  <span>Got it. Love it.</span>
                  <span>✓✓</span>
                </div>
                <svg className="sketch-arrow" viewBox="0 0 100 90">
                  <path d="M8 5c62 8 70 45 45 70m-3-21 2 24 25-8" />
                </svg>
                <span className="handwritten">a little more human.</span>
              </div>
            </section>
          )}
          <section className="library-section">
            <div className="section-heading">
              <div className="library-title">
                <h2>
                  {section === "library"
                    ? "Your library"
                    : section === "starred"
                      ? "Starred videos"
                      : section === "shared"
                        ? "Shared videos"
                        : section.slice(7)}
                </h2>
                <span className="count-pill">{filtered.length}</span>
              </div>
              <button
                className="text-button muted small"
                onClick={() => setDialog("collection")}
              >
                <Folder size={16} />
                Organize a little
                <Plus size={14} />
              </button>
            </div>
            <div className="library-toolbar">
              <div className="library-tabs">
                <button className="active">
                  {section === "shared" ? "Shared links" : "All videos"}
                </button>
                <span>
                  {section === "library"
                    ? "A home for your point of view."
                    : section === "starred"
                      ? "The ones worth keeping close."
                      : "Every link has a little context."}
                </span>
              </div>
              <div className="filter-tools">
                <label className="search-box">
                  <Search size={16} />
                  <input
                    ref={search}
                    aria-label="Search videos"
                    placeholder="Find a video…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <kbd>⌘ K</kbd>
                </label>
                <select
                  className="sort"
                  aria-label="Sort videos"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="recent">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="name">By title</option>
                  <option value="views">Most viewed</option>
                </select>
                <div className="view-toggle">
                  <button
                    className={layout === "grid" ? "active" : ""}
                    aria-label="Grid view"
                    onClick={() => setLayout("grid")}
                  >
                    <Grid2X2 size={16} />
                  </button>
                  <button
                    className={layout === "list" ? "active" : ""}
                    aria-label="List view"
                    onClick={() => setLayout("list")}
                  >
                    <List size={18} />
                  </button>
                </div>
              </div>
            </div>
            {error && (
              <div className="error" role="alert">
                {error}
                <button
                  className="text-button"
                  onClick={() => {
                    setError("");
                    void refresh().catch((e) => setError(e.message));
                  }}
                >
                  Try again
                </button>
              </div>
            )}
            {loading ? (
              <div className="empty-state">
                <LoaderCircle className="spin" />
                <h3>Getting your ideas together…</h3>
              </div>
            ) : filtered.length ? (
              <div
                className={`video-grid ${layout === "list" ? "list-view" : ""}`}
              >
                {filtered.map((c) => (
                  <article className="video-card" key={c.id}>
                    <button
                      className="thumbnail"
                      onClick={() => open(c)}
                      aria-label={`Watch ${c.title}`}
                    >
                      {c.thumbnail ? (
                        <img src={c.thumbnail} alt="" />
                      ) : (
                        <div className="fallback-thumbnail">
                          <PlayMark />
                        </div>
                      )}
                      <span className="card-play">
                        <PlayMark />
                      </span>
                      <span className="duration">{clock(c.duration)}</span>
                      {c.token && (
                        <span className="shared-pill">
                          <Link size={12} />
                          Shared
                        </span>
                      )}
                    </button>
                    <div className="card-details">
                      <button className="card-title" onClick={() => open(c)}>
                        {c.title}
                      </button>
                      <div className="card-meta">
                        <span>
                          {new Date(c.created).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                          })}
                        </span>
                        <span>·</span>
                        <span>{c.views} views</span>
                        <button
                          aria-label={
                            c.starred ? `Unstar ${c.title}` : `Star ${c.title}`
                          }
                          className={`star-button ${c.starred ? "is-starred" : ""}`}
                          onClick={async () => {
                            try {
                              update(
                                await api<Clip>(`/api/videos/${c.id}`, {
                                  method: "PATCH",
                                  body: JSON.stringify({ starred: !c.starred }),
                                }),
                              );
                            } catch (e) {
                              notify((e as Error).message);
                            }
                          }}
                        >
                          <Star
                            size={15}
                            fill={c.starred ? "currentColor" : "none"}
                          />
                        </button>
                      </div>
                      {c.folder && (
                        <span className="card-folder">
                          <Folder size={12} />
                          {c.folder}
                        </span>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <Clapperboard size={28} strokeWidth={1.2} />
                  <span>✦</span>
                </div>
                <h3>
                  {query
                    ? "No videos found."
                    : section === "library"
                      ? "Your next good idea goes here."
                      : section === "starred"
                        ? "Save a little inspiration."
                        : "Nothing here just yet."}
                </h3>
                <p>
                  {query
                    ? "Try another title, note, or collection."
                    : section === "library"
                      ? "A quick update. A big reveal. That thing that’s easier to show."
                      : section === "starred"
                        ? "Star a video in your library to keep it close."
                        : "Share a video or add it to this collection to get started."}
                </p>
                {!query && section === "library" && (
                  <div className="actions">
                    <button
                      className="btn primary"
                      onClick={() => requestRecording()}
                    >
                      <Plus size={17} />
                      Make your first video
                    </button>
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => void demo()}
                    >
                      Explore a sample
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
          {section === "library" && !query && (
            <section className="inspiration">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">A LITTLE INSPIRATION</span>
                  <h2>There’s a video for that.</h2>
                </div>
                <span className="muted small">
                  One less meeting, one good idea at a time.
                </span>
              </div>
              <div className="prompt-grid">
                {[
                  [
                    "update",
                    "The “quick update”",
                    "Keep everyone in the loop. In your own time.",
                    "01",
                  ],
                  [
                    "walkthrough",
                    "The “let me show you”",
                    "Give a great idea the context it deserves.",
                    "02",
                  ],
                  [
                    "feedback",
                    "The “one small thing”",
                    "Make your feedback clear. And a little kinder.",
                    "03",
                  ],
                ].map(([kind, title, desc, num]) => (
                  <button
                    className={`prompt-card ${kind}`}
                    key={kind}
                    onClick={() => requestRecording()}
                  >
                    <div className="prompt-art">
                      {kind === "update" ? (
                        <div className="art-update">
                          <span>MONDAY, MADE SIMPLE</span>
                          <i />
                          <i />
                          <i />
                          <b>✓</b>
                        </div>
                      ) : kind === "walkthrough" ? (
                        <div className="art-walk">
                          <span>
                            hello,
                            <br />
                            <em>good idea.</em>
                          </span>
                          <i>↗</i>
                        </div>
                      ) : (
                        <div className="art-feedback">
                          <div>
                            <span>💬</span>What if we tried…
                          </div>
                          <i>✳</i>
                        </div>
                      )}
                      <span className="prompt-number">{num}</span>
                    </div>
                    <div className="prompt-copy">
                      <h3>
                        {title}
                        <ArrowUpRight size={17} />
                      </h3>
                      <p>{desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          )}
          <footer className="main-footer">
            <span>
              <span className="tiny-dot" />
              Made for people. Built in the open.
            </span>
            <span>
              Less meeting. More meaning.{" "}
              <span className="footer-spark">✳</span>
            </span>
          </footer>
        </main>
      </div>
      <input
        type="file"
        ref={input}
        accept="video/mp4,video/webm,.relay"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {recorderModal}
      {onboarding && prefs && (
        <Onboarding
          initialName={memberName}
          preferences={prefs}
          onName={(name) =>
            setSession((s) =>
              s && s.member ? { ...s, member: { ...s.member, name } } : s,
            )
          }
          onDone={finishOnboarding}
        />
      )}
      {(dialog || help) && (
        <div
          className="dialog-backdrop"
          onClick={() => {
            setDialog("");
            setHelp(false);
          }}
        >
          <section
            className="dialog info-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={help ? "Help" : dialog}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="dialog-close icon-button"
              aria-label="Close dialog"
              onClick={() => {
                setDialog("");
                setHelp(false);
              }}
            >
              <X size={21} />
            </button>
            {dialog === "collection" ? (
              <>
                <Folder size={27} />
                <h2>A little organization.</h2>
                <p className="muted">
                  Open any video and type a collection name beneath the player.
                  Videos with the same name live together in your sidebar.
                </p>
                <button className="btn primary" onClick={() => setDialog("")}>
                  Got it
                  <Check size={16} />
                </button>
              </>
            ) : dialog === "settings" || dialog === "workspace" ? (
              <WorkspaceSettings notify={notify} />
            ) : help ? (
              <>
                <HelpCircle size={27} />
                <h2>Good to know.</h2>
                <div className="help-item">
                  <kbd>R</kbd>
                  <span>Open the recorder</span>
                </div>
                {window.relayDesktop && (
                  <>
                    <div className="help-item">
                      <kbd>⌘ ⇧ R</kbd>
                      <span>Record from anywhere · press again to finish</span>
                    </div>
                    <div className="help-item">
                      <kbd>⌥ ⇧ P</kbd>
                      <span>Pause or resume while recording</span>
                    </div>
                    <div className="help-item">
                      <kbd>⌥ ⇧ D</kbd>
                      <span>Draw on screen while recording</span>
                    </div>
                    <div className="help-item">
                      <kbd>⌥ ⇧ C</kbd>
                      <span>Discard the current recording</span>
                    </div>
                  </>
                )}
                <div className="help-item">
                  <kbd>⌘ / Ctrl K</kbd>
                  <span>Find a video</span>
                </div>
                <div className="help-item">
                  <ScissorsIcon />
                  <span>Open a video → Trim video → Save a new copy</span>
                </div>
                <p className="muted">
                  For screen capture, use Chrome, Edge or the desktop app. Your
                  browser will ask which screen to share and whether to include
                  audio.
                </p>
                <p className="small muted">
                  Share links work wherever your server is reachable. A
                  localhost link is only available on this computer.
                </p>
                <button
                  className="btn"
                  onClick={() => void openOnboarding()}
                >
                  Replay the setup guide
                  <ArrowRight size={15} />
                </button>
              </>
            ) : (
              <>
                <Logo />
                <h2>A little more human.</h2>
                <p className="muted">
                  Relay is an open-source recording studio for explaining things
                  well. Capture your screen, trim the edges, and send the whole
                  thought.
                </p>
                <div className="about-pills">
                  <span>MIT licensed</span>
                  <span>Self-hosted</span>
                  <span>No subscriptions</span>
                </div>
                <p className="small muted">
                  Version {__RELAY_VERSION__} · Built for your screen, your
                  voice, and your way of working.
                </p>
              </>
            )}
          </section>
        </div>
      )}
      {busy && (
        <div className="busy-overlay" role="status">
          <LoaderCircle className="spin" />
          {busy}
        </div>
      )}
      {toastStack}
    </div>
  );
}
function PlayMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m8 4 13 8-13 8Z" fill="currentColor" />
    </svg>
  );
}
function ScissorsIcon() {
  return <span className="shortcut-icon">✂</span>;
}
