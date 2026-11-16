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
import { Logo } from "./Logo";
import { createPortal } from "react-dom";
import { Menu as MoreMenu, Modal, confirmDialog } from "./Modal";
import { WorkspaceSettings, InvitationPage } from "./WorkspaceSettings";
import { RecoveryCenter } from "./RecoveryCenter";
import { startDraftSync } from "./drafts";
import { Editor } from "./Editor";
import { Onboarding, type OnboardingExit } from "./Onboarding";
import {
  loadPreferences,
  pref,
  preferencesLoaded,
  type Preferences,
} from "./prefs";
import { createDemo, inspectVideo } from "./media";
import { api, bytes, clock, type Clip } from "./types";
// The shortcut key people actually have on their keyboard.
const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
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
    [gone, setGone] = useState(false),
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
    // Start the new page at its heading, for keyboards and screen readers.
    setTimeout(() => {
      const heading = document.querySelector<HTMLElement>(
        "#root h1, #root main",
      );
      if (!heading) return;
      if (!heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }, 60);
  }, []);
  // Toasts stack so a background event never hides the confirmation you just asked for.
  const notify = useCallback((text: string) => {
    const id = ++toastId.current;
    setToasts((all) =>
      [...all.filter((t) => t.text !== text), { id, text }].slice(-3),
    );
    setTimeout(() => setToasts((all) => all.filter((t) => t.id !== id)), 6000);
  }, []);
  // Always mounted, so screen readers reliably announce each message.
  // It lives outside the app root so it is still announced while a dialog is open.
  const toastStack = createPortal(
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className="toast" key={t.id}>
          <Check size={17} />
          {t.text}
        </div>
      ))}
    </div>,
    document.body,
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
      // Only a successful load can tell us setup hasn't been done.
      if (
        preferencesLoaded() &&
        !p.onboarded &&
        session.member?.role !== "viewer"
      )
        setOnboarding(true);
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
  // Other screens can ask for Settings, optionally at a section.
  const [settingsFocus, setSettingsFocus] = useState("");
  useEffect(() => {
    const openSettings = (e: Event) => {
      setSettingsFocus(String((e as CustomEvent).detail || ""));
      setDialog("settings");
    };
    addEventListener("relay:open-settings", openSettings);
    return () => removeEventListener("relay:open-settings", openSettings);
  }, []);
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
          // Only a missing or expired link means "no longer shared".
          setGone([404, 410].includes((e as { status?: number }).status ?? 0));
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
        pref("keyShortcuts") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        !e.repeat &&
        // Only from the page itself: never while a dialog is open or a control has focus.
        !document.querySelector('[role="dialog"]') &&
        !(e.target as HTMLElement).closest(
          'button,a,summary,[role],[contenteditable="true"]',
        ) &&
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
  const removeClip = async (c: Clip) => {
    if (
      !(await confirmDialog({
        title: "Delete this video?",
        body: `“${c.title}”, its comments and its share link will be permanently deleted.`,
        confirm: "Delete video",
        cancel: "Keep video",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/api/videos/${c.id}`, { method: "DELETE" });
      setClips((old) => old.filter((v) => v.id !== c.id));
      notify("Video deleted");
      // The card is gone; put the keyboard back at the top of the list.
      setTimeout(() => document.getElementById("main")?.focus(), 80);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    const update = () => void refresh().catch(() => {});
    addEventListener("relay:library", update);
    return () => removeEventListener("relay:library", update);
  }, [refresh]);
  const saved = (c: Clip, copied = false) => {
    setRecord(false);
    setClips((old) => [c, ...old.filter((v) => v.id !== c.id)]);
    open(c);
    notify(copied ? "Recording saved. Share link copied." : "Recording saved.");
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
      ? "Starred"
      : section === "shared"
        ? "Shared links"
        : section.startsWith("folder:")
          ? section.slice(7)
          : "Library";
  // A brand-new library shows one welcome panel instead of an empty list.
  const firstRun =
    section === "library" && !query && !loading && clips.length === 0;
  // The phone menu behaves like a dialog: focus moves in, the page behind is inert,
  // and focus goes back to the menu button when it closes.
  const drawer = useRef<HTMLElement>(null),
    shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!mobile) return;
    const opener = document.activeElement as HTMLElement | null;
    if (shell.current) shell.current.inert = true;
    drawer.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (shell.current) shell.current.inert = false;
      opener?.focus?.();
    };
  }, [mobile]);
  // Each view names itself in the tab title.
  useEffect(() => {
    if (path.startsWith("/video/")) return;
    // Shared pages name their state until the video itself sets the title.
    if (path.startsWith("/s/") || path.startsWith("/embed/")) {
      if (!active)
        document.title = `${
          loading
            ? "Loading"
            : shareGate?.requiresLogin
              ? "Sign in to watch"
              : shareGate?.requiresPassword
                ? "Password required"
                : "Video unavailable"
        } · Relay`;
      return;
    }
    document.title = `${
      path.startsWith("/invite/")
        ? "Join the workspace"
        : session && !session.unlocked
          ? "Sign in"
          : sectionTitle
    } · Relay`;
  }, [path, sectionTitle, session, active, loading, shareGate]);
  const changeSection = (s: string) => {
    setSection(s);
    setMobile(false);
    setQuery("");
    if (path !== "/") navigate("/");
  };
  // Closing mid-recording asks first; the recorder supplies the question.
  const recorderGuard = useRef<() => Promise<boolean>>(async () => true);
  const closeRecorder = () =>
    void recorderGuard.current().then((ok) => ok && setRecord(false));
  const recorderModal = record && session?.member?.role !== "viewer" && (
    // Keyed and rendered at the same place in every view, so navigating
    // (for example Back) never unmounts a recording in progress.
    <Modal
      key="recorder"
      label="New recording"
      className="recorder-dialog"
      onClose={closeRecorder}
      dismissOnBackdrop={false}
    >
      <Recorder
        onClose={() => setRecord(false)}
        onSaved={saved}
        guard={recorderGuard}
      />
    </Modal>
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
        {dialog === "settings" && (
          <Modal
            label="Settings"
            className="settings-dialog"
            onClose={() => setDialog("")}
          >
            <WorkspaceSettings notify={notify} focus={settingsFocus} />
          </Modal>
        )}
        {toastStack}
      </>
    );
  if (token)
    return (
      <main className="loading-page">
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
                <h1>
                  {shareGate.requiresLogin
                    ? "Sign in to watch"
                    : "This video is password-protected"}
                </h1>
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
                {gone ? (
                  <>
                    <h1>This video is no longer shared</h1>
                    <p className="muted">
                      The link was turned off or has expired. Ask the person who
                      sent it for a new one.
                    </p>
                  </>
                ) : (
                  <>
                    <h1>This video didn’t load</h1>
                    <p className="muted">
                      Check your connection and try again.
                    </p>
                    <button className="btn" onClick={() => location.reload()}>
                      Try again
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}
      </main>
    );
  if (session && !session.unlocked)
    return (
      <main className="login-page">
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
          <h2>Sign in</h2>
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
            Sign in
            <ArrowRight size={17} />
          </button>
        </form>
      </main>
    );
  return (
    <>
      <div key="shell" className="app-shell">
        <a className="skip-link" href="#main">
          Skip to videos
        </a>
        <aside
          className={`sidebar ${mobile ? "is-open" : ""}`}
          ref={drawer}
          aria-label="Sidebar"
        >
          <button
            className="icon-button drawer-close"
            aria-label="Close navigation"
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
          <button
            className="brand-button"
            aria-label="Relay home"
            onClick={() => changeSection("library")}
          >
            <Logo />
          </button>
          <button className="new-recording" onClick={() => requestRecording()}>
            <span className="record-dot" />
            New recording<kbd>R</kbd>
          </button>
          <div className="nav-label">WORKSPACE</div>
          <nav aria-label="Library">
            {(
              [
                ["library", "Library", Clapperboard],
                ["starred", "Starred", Star],
                ["shared", "Shared links", Link],
              ] as const
            ).map(([s, label, Icon]) => (
              <button
                key={s as string}
                className={section === s ? "active" : ""}
                aria-current={section === s ? "page" : undefined}
                onClick={() => changeSection(s as string)}
              >
                <Icon size={18} />
                <span>{label as string}</span>
                {s === "library" && clips.length > 0 && (
                  <span className="nav-count">{clips.length}</span>
                )}
              </button>
            ))}
          </nav>
          <div className="nav-label">COLLECTIONS</div>
          <nav className="folders" aria-label="Collections">
            {folders.length ? (
              folders.map((f) => (
                <button
                  key={f}
                  className={section === `folder:${f}` ? "active" : ""}
                  aria-current={section === `folder:${f}` ? "page" : undefined}
                  onClick={() => changeSection(`folder:${f}`)}
                >
                  <Folder size={17} />
                  <span>{f}</span>
                </button>
              ))
            ) : (
              <p className="nav-hint">
                To group videos, open one, choose ⋯ and give it a collection.
              </p>
            )}
          </nav>
          <div className="sidebar-bottom">
            <button
              className="profile-row"
              aria-label={`${memberName || "Your workspace"}, Settings`}
              onClick={() => setDialog("settings")}
            >
              <span className="avatar owner" aria-hidden="true">
                {initial}
              </span>
              <span>
                <strong>{memberName || "Your workspace"}</strong>
                <small>
                  {session?.member?.role === "viewer"
                    ? "Viewer"
                    : session?.member?.role === "editor"
                      ? "Editor"
                      : window.relayDesktop
                        ? "On this Mac"
                        : "Owner"}
                </small>
              </span>
              <Settings size={17} />
            </button>
          </div>
        </aside>
        {mobile && (
          <div className="mobile-scrim" onClick={() => setMobile(false)} />
        )}
        <div className="main-shell" ref={shell}>
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              aria-expanded={mobile}
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <label className="search-box" hidden={firstRun}>
              <Search size={16} />
              <input
                ref={search}
                aria-label="Search videos"
                placeholder="Search videos"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <kbd>{mod}K</kbd>
            </label>
            <span className="topbar-spacer" />
            <div className="topbar-right">
              <RecoveryCenter onOpen={open} notify={notify} />
              <button
                className="icon-button"
                aria-label="Help"
                onClick={() => setHelp(true)}
              >
                <HelpCircle size={19} />
              </button>
            </div>
          </header>
          <main className="library-main" id="main" tabIndex={-1}>
            <div className="page-intro">
              <h1>{sectionTitle}</h1>
              <div className="actions" hidden={firstRun}>
                <button className="btn" onClick={() => input.current?.click()}>
                  <Upload size={16} />
                  Upload
                </button>
                <button
                  className="btn primary phone-only"
                  onClick={() => requestRecording()}
                >
                  <span className="record-dot" />
                  New recording
                </button>
              </div>
            </div>
            {error && firstRun && (
              <div className="error" role="alert">
                {error}
              </div>
            )}
            {firstRun && (
              <section className="hero">
                <div className="hero-copy">
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
                  <button
                    className="hero-cta"
                    onClick={() => requestRecording()}
                  >
                    <span className="record-dot" />
                    Record your first video
                    <ArrowUpRight size={18} />
                  </button>
                  <span className="hero-footnote">
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => void demo()}
                    >
                      Try a sample video
                    </button>
                    <span aria-hidden="true">·</span>
                    <button
                      className="text-button"
                      onClick={() => input.current?.click()}
                    >
                      Upload a video
                    </button>
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
            <section className="library-section" hidden={firstRun}>
              <div className="library-toolbar">
                <span className="library-count" role="status">
                  {filtered.length} {filtered.length === 1 ? "video" : "videos"}
                </span>
                <div className="filter-tools">
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
                      aria-pressed={layout === "grid"}
                      aria-label="Grid view"
                      onClick={() => setLayout("grid")}
                    >
                      <Grid2X2 size={16} />
                    </button>
                    <button
                      className={layout === "list" ? "active" : ""}
                      aria-pressed={layout === "list"}
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
                  <h2>Loading your videos…</h2>
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
                        aria-label={`Watch ${c.title}, ${clock(c.duration)}${c.token ? ", shared" : ""}`}
                      >
                        {c.thumbnail ? (
                          <img src={c.thumbnail} alt="" loading="lazy" />
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
                          <span>
                            {c.views} {c.views === 1 ? "view" : "views"}
                          </span>
                          <button
                            aria-label={
                              c.starred
                                ? `Unstar ${c.title}`
                                : `Star ${c.title}`
                            }
                            className={`star-button ${c.starred ? "is-starred" : ""}`}
                            onClick={async () => {
                              try {
                                update(
                                  await api<Clip>(`/api/videos/${c.id}`, {
                                    method: "PATCH",
                                    body: JSON.stringify({
                                      starred: !c.starred,
                                    }),
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
                          {canEdit && (
                            <MoreMenu
                              label={`More options for ${c.title}`}
                              className="card-menu"
                            >
                              <button
                                className="menu-item"
                                data-close
                                onClick={() => open(c)}
                              >
                                Open
                              </button>
                              <a
                                className="menu-item"
                                data-close
                                href={`/api/media/${c.id}?download=1`}
                              >
                                Download
                              </a>
                              {c.token && (
                                <button
                                  className="menu-item"
                                  data-close
                                  onClick={() =>
                                    void navigator.clipboard
                                      .writeText(
                                        `${location.origin}/s/${c.token}`,
                                      )
                                      .then(() => notify("Share link copied"))
                                  }
                                >
                                  Copy share link
                                </button>
                              )}
                              <button
                                className="menu-item danger"
                                data-close
                                onClick={() => void removeClip(c)}
                              >
                                Delete
                              </button>
                            </MoreMenu>
                          )}
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
                  <h2>
                    {query
                      ? "No videos match that search"
                      : section === "library"
                        ? "No videos yet"
                        : section === "starred"
                          ? "No starred videos"
                          : "Nothing here yet"}
                  </h2>
                  <p>
                    {query
                      ? "Try another title, note, or collection."
                      : section === "library"
                        ? "Record your screen, your camera or both. Your videos appear here."
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
                        Record a video
                      </button>
                      <button
                        className="text-button"
                        disabled={!!busy}
                        onClick={() => void demo()}
                      >
                        Try a sample video
                        <ArrowUpRight size={15} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>
          </main>
        </div>
        <input
          type="file"
          ref={input}
          accept="video/mp4,video/webm,video/quicktime,.mov,.relay"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
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
          <Modal
            label={help ? "Help" : "Settings"}
            className={help ? "info-dialog" : "settings-dialog"}
            onClose={() => {
              setDialog("");
              setHelp(false);
            }}
          >
            {help ? (
              <>
                <h2>Help</h2>
                <h3 className="help-heading">Keyboard shortcuts</h3>
                <dl className="shortcut-list">
                  <div>
                    <dt>
                      <kbd>R</kbd>
                    </dt>
                    <dd>New recording</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{mod} K</kbd>
                    </dt>
                    <dd>Search your videos</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>{mod} Z</kbd>
                    </dt>
                    <dd>Undo an edit (add Shift to redo)</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Delete</kbd>
                    </dt>
                    <dd>Cut the selected words in a transcript</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>←</kbd> <kbd>→</kbd> <kbd>Delete</kbd>
                    </dt>
                    <dd>
                      On a timeline bar: move it (add Shift to change its
                      length) or remove it
                    </dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>F</kbd> <kbd>M</kbd>
                    </dt>
                    <dd>Full screen and mute while watching</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>Space</kbd>
                    </dt>
                    <dd>Play or pause</dd>
                  </div>
                  <div>
                    <dt>
                      <kbd>← →</kbd>
                    </dt>
                    <dd>Skip back or forward 5 seconds</dd>
                  </div>
                  {window.relayDesktop && (
                    <>
                      <div>
                        <dt>
                          <kbd>⌥ ⇧ R</kbd>
                        </dt>
                        <dd>Record from anywhere; press again to finish</dd>
                      </div>
                      <div>
                        <dt>
                          <kbd>⌥ ⇧ P</kbd>
                        </dt>
                        <dd>Pause or resume a recording</dd>
                      </div>
                      <div>
                        <dt>
                          <kbd>⌥ ⇧ D</kbd>
                        </dt>
                        <dd>Draw on screen while recording</dd>
                      </div>
                      <div>
                        <dt>
                          <kbd>⌥ ⇧ C</kbd>
                        </dt>
                        <dd>Discard the current recording</dd>
                      </div>
                    </>
                  )}
                </dl>
                <h3 className="help-heading">Good to know</h3>
                <p className="muted">
                  {window.relayDesktop
                    ? "Your recordings are stored on this Mac. Share links work on this computer while Relay is open."
                    : "To record your screen, use Chrome or Edge, or the Relay Mac app. Your browser asks which screen to share."}
                </p>
                <div className="dialog-footer">
                  <span className="small muted">Relay {__RELAY_VERSION__}</span>
                  <button className="btn" onClick={() => void openOnboarding()}>
                    Replay the setup guide
                  </button>
                </div>
              </>
            ) : (
              <WorkspaceSettings notify={notify} focus={settingsFocus} />
            )}
          </Modal>
        )}
        {busy && (
          <div className="busy-overlay" role="status">
            <LoaderCircle className="spin" />
            {busy}
          </div>
        )}
        {toastStack}
      </div>
      {recorderModal}
    </>
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
