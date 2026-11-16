import { radio, tab as tabAttrs, tabPanel } from "./Modal";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { DraftPlayer, type DraftPlayerHandle } from "./DraftPlayer";
import { Timeline } from "./Timeline";
import { LookControls, Slider } from "./LookPanel";
import { AssistCard } from "./AssistCard";
const isTitle = (type: string) =>
  type === "title" || type === "lowerthird" || type === "chapter";
import type { LayoutPreset } from "./layoutPlan";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Download,
  FileText,
  Layers,
  LoaderCircle,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  Play,
  Palette,
  Send,
} from "lucide-react";
import {
  api,
  clock,
  type Clip,
  type Job,
  type Project,
  type ProjectState,
  type Word,
  type Outline,
} from "./types";
import { awaitJob } from "./drafts";
const freshId = () => crypto.randomUUID();
export type WorkbenchHandle = DraftPlayerHandle & {
  // Renders the current edits into the shared video; false if it didn't finish.
  publish: () => Promise<boolean>;
};
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl ";
const OVERLAY_NAMES: Record<string, string> = {
  title: "Title card",
  lowerthird: "Name and role",
  chapter: "Chapter label",
  zoom: "Zoom",
  text: "Text",
  arrow: "Arrow",
  box: "Outline",
  blur: "Blur",
  cursor: "Dot",
};
export const StudioWorkbench = forwardRef<
  WorkbenchHandle,
  {
    clip: Clip;
    onRendered: (v: Clip) => void;
    notify: (message: string) => void;
    onTime?: (time: number) => void;
    onPending?: (pending: boolean) => void;
  }
>(function StudioWorkbench(
  { clip, onRendered, notify, onTime, onPending },
  ref,
) {
  const player = useRef<DraftPlayerHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      seek: (t) => player.current?.seek(t),
      time: () => player.current?.time() ?? 0,
      pause: () => player.current?.pause(),
      toggle: () => player.current?.toggle(),
      publish: () => publishRef.current(),
    }),
    [],
  );
  const publishRef = useRef<() => Promise<boolean>>(async () => false);
  const onSeek = (time: number) => player.current?.seek(time);
  const [saving, setSaving] = useState(false),
    [saveFailed, setSaveFailed] = useState(false);
  const [state, setState] = useState<ProjectState | null>(null),
    [project, setProject] = useState<Project | null>(null),
    [tab, setTab] = useState("edit"),
    [videos, setVideos] = useState<Clip[]>([]),
    [addId, setAddId] = useState(""),
    [selectedRaw, setSelected] = useState(0),
    [previewing, setPreviewing] = useState("base"),
    [focusWord, setFocusWord] = useState(0),
    [editingWord, setEditingWord] = useState<number | null>(null),
    [cutStart, setCutStart] = useState(0),
    [cutEnd, setCutEnd] = useState(1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [job, setJob] = useState<Job | null>(null),
    [dirty, setDirty] = useState(false),
    [words, setWords] = useState<Word[]>([]),
    [sourceId, setSourceId] = useState(clip.id),
    [wordSelection, setWordSelection] = useState<number[]>([]),
    [search, setSearch] = useState(""),
    [model, setModel] = useState("Xenova/whisper-tiny.en"),
    [outline, setOutline] = useState<Outline>(clip.outline || {}),
    [provider, setProvider] = useState("local"),
    [consent, setConsent] = useState(false),
    [suggestions, setSuggestions] = useState<
      {
        sourceId: string;
        start: number;
        end: number;
        kind: string;
        text?: string;
      }[]
    >([]),
    [chosen, setChosen] = useState<number[]>([]),
    [context, setContext] = useState(""),
    [format, setFormat] = useState("message");
  // The preview and tabs stay pinned, smaller, while the tools below are scrolled.
  const sentinel = useRef<HTMLDivElement>(null),
    dock = useRef<HTMLDivElement>(null);
  const ready = Boolean(project && state);
  useEffect(() => {
    const mark = sentinel.current,
      box = dock.current;
    if (!mark || !box || !("IntersectionObserver" in window)) return;
    const watch = new IntersectionObserver(([entry]) => {
      const stuck =
        !entry.isIntersecting &&
        entry.boundingClientRect.top < 0 &&
        innerWidth > 900 &&
        innerHeight > 640;
      if (stuck === box.classList.contains("is-stuck")) return;
      if (stuck) {
        // Keep the page the same length so nothing jumps as the preview shrinks.
        const full = box.offsetHeight;
        box.classList.add("is-stuck");
        box.style.marginBottom = `${full - box.offsetHeight}px`;
        // Focused controls scroll into view below the pinned preview, not under it.
        document.documentElement.style.scrollPaddingTop = `${box.offsetHeight + 12}px`;
      } else {
        box.classList.remove("is-stuck");
        box.style.marginBottom = "";
        document.documentElement.style.scrollPaddingTop = "";
      }
    });
    watch.observe(mark);
    return () => {
      watch.disconnect();
      document.documentElement.style.scrollPaddingTop = "";
    };
  }, [ready]);
  const undo = useRef<Project[]>([]),
    redo = useRef<Project[]>([]),
    anchorWord = useRef<number | null>(null),
    marker = useRef<HTMLElement>(null),
    importCaptions = useRef<HTMLInputElement>(null),
    unused = useRef<HTMLDivElement>(null);
  void unused;
  const load = async () => {
    const s = await api<ProjectState>(`/api/videos/${clip.id}/project`);
    setState(s);
    setProject(s.project);
    setDirty(false);
    setSelected(0);
  };
  const transcript = async () => {
    const result = await api<{ words: Word[]; outline: Outline }>(
      `/api/videos/${sourceId}/transcript`,
    );
    setWords(result.words);
    setWordSelection([]);
    if (sourceId === clip.id) setOutline(result.outline);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    void api<Clip[]>("/api/videos")
      .then(setVideos)
      .catch(() => {});
  }, [clip.id]);
  useEffect(() => {
    void transcript().catch((e) => setError(e.message));
  }, [sourceId]);
  // One drag of a slider or one burst of typing is a single step to undo.
  const lastChange = useRef(0);
  const change = (next: Project) => {
    const now = Date.now();
    if (project && now - lastChange.current > 700)
      undo.current.push(structuredClone(project));
    lastChange.current = now;
    redo.current = [];
    setProject(next);
    setDirty(true);
  };
  const edit = (fn: (p: Project) => void) => {
    if (!project) return;
    const next = structuredClone(project);
    fn(next);
    // Trimming can leave a title or effect hanging past the end: keep what fits.
    const length = next.segments.reduce((n, s) => n + s.end - s.start, 0);
    next.overlays = next.overlays
      .filter((o) => o.start <= length - 0.1)
      .map((o) => (o.end > length ? { ...o, end: length } : o));
    if (next.scenes)
      next.scenes = next.scenes
        .map((s) => (s.end > length ? { ...s, end: length } : s))
        .filter((s) => s.end - s.start >= 0.5);
    change(next);
  };
  const total = project?.segments.reduce((n, s) => n + s.end - s.start, 0) || 0;
  const latest = useRef(project);
  latest.current = project;
  const persist = async () => {
    if (!project) return;
    const snapshot = project;
    setSaving(true);
    setSaveFailed(false);
    try {
      const result = await api<ProjectState>(`/api/videos/${clip.id}/project`, {
        method: "PUT",
        body: JSON.stringify(snapshot),
      });
      setState(result);
      // Only settle if nothing changed while this was saving.
      if (latest.current === snapshot) setDirty(false);
      return result;
    } catch (e) {
      setSaveFailed(true);
      throw e;
    } finally {
      setSaving(false);
    }
  };
  // Edits save themselves a moment after you stop.
  useEffect(() => {
    if (!dirty || !project) return;
    const timer = setTimeout(
      () => void persist().catch((e) => setError((e as Error).message)),
      900,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, dirty]);
  // Leaving mid-edit still saves.
  const unsaved = useRef<Project | null>(null);
  unsaved.current = dirty ? project : null;
  useEffect(() => {
    const flush = () => {
      if (unsaved.current)
        void fetch(`/api/videos/${clip.id}/project`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(unsaved.current),
          keepalive: true,
        }).catch(() => {});
    };
    // Closing the tab a moment after an edit still saves it.
    addEventListener("pagehide", flush);
    return () => {
      removeEventListener("pagehide", flush);
      flush();
    };
  }, [clip.id]);
  const pending =
    dirty ||
    Boolean(
      state?.published &&
      project &&
      JSON.stringify(state.published) !== JSON.stringify(project),
    );
  useEffect(() => onPending?.(pending), [pending, onPending]);
  const action = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      // Problems are also said out loud, wherever the page is scrolled to.
      notify(`${label} didn’t finish. ${(e as Error).message}`);
      return false;
    } finally {
      setBusy("");
      setJob(null);
    }
  };
  const runJob = async (label: string, path: string, body: unknown) =>
    action(label, async () => {
      const j = await api<Job>(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const complete = await awaitJob(j, setJob);
      if (complete.result?.videoId) {
        const next = await api<Clip>(`/api/videos/${complete.result.videoId}`);
        if (next.id === clip.id) {
          onRendered(next);
          setOutline(next.outline || {});
          await transcript();
        } else {
          notify("Edited copy saved to your library");
          dispatchEvent(new CustomEvent("relay:library"));
        }
      }
    });
  // Undo can shrink the section list under the selection; never index past it.
  const selected = Math.max(
    0,
    Math.min(selectedRaw, (project?.segments.length ?? 1) - 1),
  );
  const hasCameraTrack = Boolean(
    state?.sources.some((x) => x.role === "screen") &&
    state?.sources.some((x) => x.role === "camera"),
  );
  const history = async (direction: "undo" | "redo") => {
    if (!project) return;
    const from = direction === "undo" ? undo : redo,
      to = direction === "undo" ? redo : undo;
    lastChange.current = 0;
    if (from.current.length) {
      to.current.push(project);
      setProject(from.current.pop()!);
      setDirty(true);
    } else
      await action(direction, async () => {
        const s = await api<ProjectState>(
          `/api/videos/${clip.id}/project/${direction}`,
          { method: "POST" },
        );
        setState(s);
        setProject(s.project);
        setDirty(false);
      });
  };
  const addSection = async (replace = false) => {
    if (!addId) return;
    const s = await api<ProjectState>(`/api/videos/${addId}/project`);
    edit((p) => {
      const section = { sourceId: addId, start: 0, end: s.sourceDuration };
      if (replace) p.segments[selected] = section;
      else p.segments.push(section);
    });
    setAddId("");
  };
  const cut = async (
    ranges: { sourceId: string; start: number; end: number }[],
  ) => {
    await persist();
    let result: ProjectState | undefined;
    for (const source of new Set(ranges.map((r) => r.sourceId))) {
      result = await api<ProjectState>(`/api/videos/${clip.id}/project/cut`, {
        method: "POST",
        body: JSON.stringify({
          sourceId: source,
          ranges: ranges.filter((r) => r.sourceId === source),
        }),
      });
    }
    if (result) {
      setState(result);
      setProject(result.project);
      setDirty(false);
      setSelected(0);
      notify("Removed. Your original recording is untouched.");
    }
  };
  const publish = () =>
    action("Updating the video", async () => {
      await persist();
      const j = await api<Job>(`/api/videos/${clip.id}/render`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await awaitJob(j, setJob);
      onRendered(await api<Clip>(`/api/videos/${clip.id}`));
      await load();
      notify(
        clip.token
          ? "Video updated. Your share link now plays this version."
          : "Video updated.",
      );
    });
  publishRef.current = publish;
  const historyRef = useRef(history);
  historyRef.current = history;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      // Text fields keep their own undo.
      const el = e.target as HTMLElement;
      if (el.closest("input:not([type=range]):not([type=checkbox]),textarea"))
        return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      void historyRef.current(e.shiftKey ? "redo" : "undo");
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (!project || !state)
    return (
      <section className="studio-workbench">
        <LoaderCircle className="spin" size={18} />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    );
  const sourceIds = [
    ...new Set([clip.id, ...project.segments.map((s) => s.sourceId)]),
  ];
  const selectedSection =
    project.segments[Math.min(selected, project.segments.length - 1)];
  const sectionStart = (i: number) =>
    project.segments.slice(0, i).reduce((n, s) => n + s.end - s.start, 0);
  // How long the footage behind the selected section is.
  const selectedMax = Math.max(
    selectedSection.end,
    selectedSection.sourceId === clip.id
      ? state.sourceDuration
      : videos.find((v) => v.id === selectedSection.sourceId)?.duration || 0,
  );
  // Which section the playhead is in, and where that is in the original footage.
  const playhead = () => {
    const t = player.current?.time() ?? 0;
    let offset = 0,
      i = 0;
    for (; i < project.segments.length - 1; i++) {
      const length = project.segments[i].end - project.segments[i].start;
      if (t < offset + length) break;
      offset += length;
    }
    const section = project.segments[i];
    return {
      i,
      section,
      source: Math.min(section.end, section.start + Math.max(0, t - offset)),
    };
  };
  const saveOutline = () => {
    if (JSON.stringify(outline) === JSON.stringify(clip.outline || {})) return;
    void api<Clip>(`/api/videos/${clip.id}/outline`, {
      method: "PUT",
      body: JSON.stringify(outline),
    })
      .then((v) => {
        onRendered(v);
        notify("Summary saved");
      })
      .catch((e) => setError((e as Error).message));
  };
  // Corrected words save themselves, like every other edit.
  const saveWords = (next: Word[]) => {
    setWords(next);
    void api(`/api/videos/${sourceId}/transcript`, {
      method: "PUT",
      body: JSON.stringify({ words: next }),
    })
      .then(() => notify("Correction saved"))
      .catch((e) => setError((e as Error).message));
  };
  // Words whose moment is no longer in the video.
  const isCut = (w: Word) => {
    const mid = (w.start + w.end) / 2;
    return !project.segments.some(
      (seg) => seg.sourceId === sourceId && mid >= seg.start && mid < seg.end,
    );
  };
  const cutSelected = () =>
    void action("Cutting selected words", async () => {
      await cut(
        wordSelection.map((i) => ({
          sourceId,
          start: words[i].start,
          end: words[i].end,
        })),
      );
      setWordSelection([]);
    });
  // New titles and effects start where the playhead is.
  const at = () =>
    +Math.max(0, Math.min(total - 1, player.current?.time() ?? 0)).toFixed(1);
  const overlayRow = (o: Project["overlays"][number], i: number) => (
    <div
      className="effect-row"
      key={o.id}
      role="group"
      aria-labelledby={`fx-${o.id}`}
    >
      <strong id={`fx-${o.id}`}>
        {OVERLAY_NAMES[o.type] || o.type}
        {o.auto && <small className="muted"> · added for you</small>}
        {!isTitle(o.type) && (
          <small className="muted effect-tip">
            {o.type === "zoom"
              ? "Pause on it, then drag the circle in the preview to aim the zoom."
              : "Pause on it, then drag it in the preview to place it."}
          </small>
        )}
      </strong>
      {(o.type === "text" || isTitle(o.type)) && (
        <label className="effect-text">
          {o.type === "lowerthird"
            ? "Name"
            : o.type === "chapter"
              ? "Label"
              : o.type === "title"
                ? "Title"
                : "Words"}
          <input
            value={o.text}
            maxLength={500}
            onChange={(e) => edit((p) => (p.overlays[i].text = e.target.value))}
          />
        </label>
      )}
      {(o.type === "title" || o.type === "lowerthird") && (
        <label className="effect-text">
          {o.type === "title" ? "Subtitle" : "Role"}
          <input
            value={o.sub || ""}
            maxLength={200}
            onChange={(e) => edit((p) => (p.overlays[i].sub = e.target.value))}
          />
        </label>
      )}
      <label>
        Starts at (sec)
        <input
          type="number"
          min={0}
          max={total}
          step=".1"
          value={o.start}
          onChange={(e) => edit((p) => (p.overlays[i].start = +e.target.value))}
        />
      </label>
      <label>
        Ends at (sec)
        <input
          type="number"
          min={0}
          max={total}
          step=".1"
          value={o.end}
          onChange={(e) => edit((p) => (p.overlays[i].end = +e.target.value))}
        />
      </label>
      {!isTitle(o.type) && (
        <details className="cut-more effect-position">
          <summary>Exact position</summary>
          <div className="effect-fields">
            {(o.type === "blur" || o.type === "box"
              ? (["x", "y", "w", "h"] as const)
              : (["x", "y"] as const)
            ).map((key) => (
              <label key={key}>
                {{ x: "Left", y: "Top", w: "Width", h: "Height" }[key]} %
                <input
                  type="number"
                  min={key === "x" || key === "y" ? 0 : 1}
                  max={key === "x" || key === "y" ? 95 : 100}
                  value={Math.round(o[key] * 100)}
                  onChange={(e) =>
                    edit((p) => (p.overlays[i][key] = +e.target.value / 100))
                  }
                />
              </label>
            ))}
          </div>
        </details>
      )}
      {o.type === "zoom" && (
        <label>
          Zoom ×
          <input
            type="number"
            min={1}
            max={4}
            step=".1"
            value={o.scale}
            onChange={(e) =>
              edit((p) => (p.overlays[i].scale = +e.target.value))
            }
          />
        </label>
      )}
      <input
        aria-label={`${OVERLAY_NAMES[o.type]} colour`}
        title="Colour"
        type="color"
        value={o.color}
        onChange={(e) => edit((p) => (p.overlays[i].color = e.target.value))}
      />
      <span className="effect-actions">
        <button
          className="btn"
          aria-label={`Start here: ${OVERLAY_NAMES[o.type]}`}
          onClick={() =>
            edit((p) => {
              const length = Math.max(1, o.end - o.start);
              p.overlays[i].start = at();
              p.overlays[i].end = +Math.min(total, at() + length).toFixed(1);
            })
          }
        >
          Start here
        </button>
        <button
          className="btn"
          aria-label={`End here: ${OVERLAY_NAMES[o.type]}`}
          onClick={() =>
            edit((p) => {
              p.overlays[i].end = +Math.max(
                p.overlays[i].start + 0.5,
                player.current?.time() ?? 0,
              ).toFixed(1);
            })
          }
        >
          End here
        </button>
        <button
          className="btn"
          aria-label={`Go to it: ${OVERLAY_NAMES[o.type]}`}
          onClick={() => onSeek(o.start + 0.05)}
        >
          Go to it
        </button>
      </span>
      <button
        className="icon-button danger"
        aria-label={`Remove ${OVERLAY_NAMES[o.type]}`}
        onClick={(e) => {
          // Leave the keyboard on the card's first add button once the row is gone.
          const card = e.currentTarget.closest(".look-card");
          edit((p) => p.overlays.splice(i, 1));
          card
            ?.querySelector<HTMLElement>(
              ".title-add button, .effect-add button",
            )
            ?.focus();
        }}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
  return (
    <section
      className="studio-workbench"
      style={{
        ["--ratio" as string]: project.layout.width / project.layout.height,
      }}
    >
      <div className="preview-sentinel" ref={sentinel} />
      <div className="preview-dock" ref={dock}>
        <div className="stage">
          <DraftPlayer
            ref={player}
            project={project}
            videoId={clip.id}
            hasCamera={hasCameraTrack}
            words={sourceId === clip.id ? words : []}
            onTime={(t) => {
              // The line on the Cut timeline follows the preview.
              if (marker.current && total)
                marker.current.style.left = `${Math.min(100, (t / total) * 100)}%`;
              onTime?.(t);
            }}
            onCamera={(position) =>
              edit((p) => Object.assign(p.layout.camera, position))
            }
            onOverlay={(id, patch) =>
              edit((p) => {
                const overlay = p.overlays.find((o) => o.id === id);
                if (overlay) Object.assign(overlay, patch);
              })
            }
          />
          <Timeline
            project={project}
            total={total}
            selected={selected}
            onSelect={(index, start) => {
              setSelected(index);
              onSeek(start);
            }}
            onSeek={onSeek}
            edit={edit}
            marker={marker}
            names={OVERLAY_NAMES}
            onPick={(key) => {
              // Open the Look tab at this item's settings.
              setTab("style");
              setTimeout(() => {
                const row = document
                  .getElementById(`fx-${key}`)
                  ?.closest<HTMLElement>(".effect-row");
                if (!row) return;
                row.scrollIntoView({
                  block: "center",
                  behavior: matchMedia("(prefers-reduced-motion: reduce)")
                    .matches
                    ? "auto"
                    : "smooth",
                });
                // The bar that was used may now be hidden; carry on from its settings.
                row
                  .querySelector<HTMLElement>("input,select,button")
                  ?.focus({ preventScroll: true });
                row.classList.add("is-picked");
                setTimeout(() => row.classList.remove("is-picked"), 1600);
              }, 80);
            }}
          />
        </div>
        <div className="studio-status">
          <div className="actions">
            <button
              className="icon-button"
              aria-label="Undo"
              title={`Undo (${MOD}Z)`}
              disabled={!undo.current.length && !state.canUndo}
              onClick={() => void history("undo")}
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Redo"
              title={`Redo (Shift ${MOD}Z)`}
              disabled={!redo.current.length && !state.canRedo}
              onClick={() => void history("redo")}
            >
              <Redo2 size={17} />
            </button>
          </div>
          <span
            className={`save-state ${pending ? "is-pending" : ""}`}
            role="status"
          >
            {saveFailed ? (
              <>
                Couldn’t save your edits.{" "}
                <button
                  className="text-button"
                  onClick={() =>
                    void persist().catch((e) => setError((e as Error).message))
                  }
                >
                  Try again
                </button>
              </>
            ) : saving || dirty ? (
              "Saving…"
            ) : pending ? (
              clip.token ? (
                "Edits saved. Update the video to share them."
              ) : (
                "Edits saved. Update the video to finish."
              )
            ) : (
              "Video is up to date"
            )}
          </span>
          <div className="actions">
            <button
              className="btn small"
              disabled={!!busy}
              onClick={() =>
                void action("Saving a new video", async () => {
                  await persist();
                  const j = await api<Job>(`/api/videos/${clip.id}/render`, {
                    method: "POST",
                    body: JSON.stringify({ copy: true }),
                  });
                  await awaitJob(j, setJob);
                  notify("Saved as a new video in your library");
                  dispatchEvent(new CustomEvent("relay:library"));
                })
              }
            >
              Save as new video
            </button>
            <button
              className="btn primary small"
              disabled={!!busy || !pending}
              onClick={() => void publish()}
            >
              <Send size={14} />
              Update video
            </button>
          </div>
        </div>
        {busy && (
          <div className="studio-job" role="status">
            <LoaderCircle size={16} className="spin" />
            {busy}
            {job && (
              <>
                <progress
                  max={100}
                  value={job.progress}
                  aria-label={`${busy} progress`}
                />
                <span aria-hidden="true">{Math.round(job.progress)}%</span>
              </>
            )}
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="studio-tabs" role="tablist" aria-label="Editing tools">
          {(
            [
              ["edit", "Cut", Scissors],
              ["transcript", "Transcript", FileText],
              ["style", "Look", Palette],
              ["ai", "AI", Sparkles],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              {...tabAttrs(tab === id, `studio-${id}`)}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(id)}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </div>
      </div>
      {tab === "edit" && (
        <div className="studio-content" {...tabPanel("studio-edit")}>
          <p className="studio-hint">
            Your video is made of sections. Trim a section’s start or end, split
            it where the video is paused, or remove it. Nothing is ever deleted
            from the original recording.
          </p>
          <div className="cut-editor">
            <div className="cut-heading">
              <strong>
                Section {selected + 1} of {project.segments.length}
              </strong>
              <span className="small muted">
                {videos.find((v) => v.id === selectedSection.sourceId)?.title ||
                  "This recording"}{" "}
                · {clock(selectedSection.start)} to {clock(selectedSection.end)}
              </span>
            </div>
            <div
              className="trim-range"
              style={{
                ["--from" as string]: `${(selectedSection.start / selectedMax) * 100}%`,
                ["--to" as string]: `${(selectedSection.end / selectedMax) * 100}%`,
              }}
            >
              <input
                type="range"
                aria-label="Section start"
                aria-valuetext={clock(selectedSection.start)}
                min={0}
                max={selectedMax}
                step={0.05}
                value={selectedSection.start}
                onChange={(e) => {
                  const v = Math.min(
                    +e.target.value,
                    selectedSection.end - 0.2,
                  );
                  edit((p) => (p.segments[selected].start = Math.max(0, v)));
                  // Show the new first frame while the handle moves.
                  requestAnimationFrame(() => onSeek(sectionStart(selected)));
                }}
              />
              <input
                type="range"
                aria-label="Section end"
                aria-valuetext={clock(selectedSection.end)}
                min={0}
                max={selectedMax}
                step={0.05}
                value={selectedSection.end}
                onChange={(e) => {
                  const v = Math.max(
                    +e.target.value,
                    selectedSection.start + 0.2,
                  );
                  const end = Math.min(selectedMax, v);
                  edit((p) => (p.segments[selected].end = end));
                  // Show the new last frame while the handle moves.
                  requestAnimationFrame(() =>
                    onSeek(
                      sectionStart(selected) +
                        Math.max(0, end - selectedSection.start - 0.05),
                    ),
                  );
                }}
              />
            </div>
            <div className="cut-actions">
              <button
                className="btn small"
                onClick={() => {
                  const here = playhead();
                  if (here.source < here.section.end - 0.2)
                    edit((p) => (p.segments[here.i].start = here.source));
                  setSelected(here.i);
                }}
              >
                Start here
              </button>
              <button
                className="btn small"
                onClick={() => {
                  const here = playhead();
                  if (here.source > here.section.start + 0.2)
                    edit((p) => (p.segments[here.i].end = here.source));
                  setSelected(here.i);
                }}
              >
                End here
              </button>
              <button
                className="btn small"
                onClick={() => {
                  const here = playhead();
                  if (
                    here.source > here.section.start + 0.2 &&
                    here.source < here.section.end - 0.2
                  ) {
                    edit((p) =>
                      p.segments.splice(
                        here.i,
                        1,
                        { ...here.section, end: here.source },
                        { ...here.section, start: here.source },
                      ),
                    );
                    setSelected(here.i + 1);
                  } else
                    notify("Move the playhead inside a section to split it.");
                }}
              >
                <Scissors size={14} />
                Split here
              </button>
              <span className="cut-spacer" />
              <button
                className="btn small"
                aria-label="Move section earlier"
                disabled={selected === 0}
                onClick={() => {
                  edit((p) => {
                    [p.segments[selected - 1], p.segments[selected]] = [
                      p.segments[selected],
                      p.segments[selected - 1],
                    ];
                  });
                  setSelected(selected - 1);
                }}
              >
                <ArrowUp size={14} />
                Earlier
              </button>
              <button
                className="btn small"
                aria-label="Move section later"
                disabled={selected === project.segments.length - 1}
                onClick={() => {
                  edit((p) => {
                    [p.segments[selected + 1], p.segments[selected]] = [
                      p.segments[selected],
                      p.segments[selected + 1],
                    ];
                  });
                  setSelected(selected + 1);
                }}
              >
                <ArrowDown size={14} />
                Later
              </button>
              <button
                className="btn small danger"
                disabled={project.segments.length === 1}
                onClick={() => {
                  edit((p) => p.segments.splice(selected, 1));
                  setSelected(Math.max(0, selected - 1));
                }}
              >
                <Trash2 size={14} />
                Remove section
              </button>
            </div>
          </div>
          <div className="cut-cleanup">
            <button
              className="btn small"
              disabled={!!busy}
              onClick={() =>
                void action("Looking for pauses and filler words", async () => {
                  const result = await api<typeof suggestions>(
                    `/api/videos/${sourceId}/suggestions`,
                    { method: "POST" },
                  );
                  setSuggestions(result);
                  setChosen(result.map((_, i) => i));
                  if (!result.length)
                    notify("No long pauses or filler words found.");
                })
              }
            >
              <Sparkles size={14} />
              Find pauses and filler words
            </button>
            <span className="small muted">
              You choose which ones to remove.
            </span>
          </div>
          {suggestions.length > 0 && (
            <div className="cleanup-list">
              <h2>
                {suggestions.length} suggested{" "}
                {suggestions.length === 1 ? "cut" : "cuts"}
              </h2>
              {suggestions.map((s, i) => (
                <label key={i}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(i)}
                    onChange={(e) =>
                      setChosen(
                        e.target.checked
                          ? [...chosen, i]
                          : chosen.filter((n) => n !== i),
                      )
                    }
                  />
                  <span>
                    {s.kind === "filler"
                      ? `“${(s.text || "um").trim()}”`
                      : "Pause"}{" "}
                    · {clock(s.start)} ({(s.end - s.start).toFixed(1)}s)
                  </span>
                  <button
                    type="button"
                    className="text-button"
                    onClick={(e) => {
                      e.preventDefault();
                      onSeek(Math.max(0, s.start - 1));
                    }}
                  >
                    <Play size={12} />
                    Listen
                  </button>
                </label>
              ))}
              <button
                className="btn small primary"
                disabled={!chosen.length || !!busy}
                onClick={() =>
                  void action("Removing", async () => {
                    await cut(chosen.map((i) => suggestions[i]));
                    setSuggestions([]);
                  })
                }
              >
                Remove {chosen.length} selected
              </button>
            </div>
          )}
          <details className="cut-more">
            <summary>Add footage or export the project</summary>
            <div className="add-section">
              <select
                aria-label="Video to add"
                value={addId}
                onChange={(e) => setAddId(e.target.value)}
              >
                <option value="">Choose a video from your library…</option>
                {videos.map((v) => (
                  <option value={v.id} key={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
              <button
                className="btn small"
                disabled={!addId}
                onClick={() => void action("Adding", () => addSection())}
              >
                <Plus size={14} />
                Add to the end
              </button>
              <button
                className="btn small"
                disabled={!addId}
                onClick={() => void action("Replacing", () => addSection(true))}
              >
                Replace this section
              </button>
            </div>
            <a
              className="btn small"
              href={`/api/videos/${clip.id}/project.bundle`}
            >
              <Download size={14} />
              Export as a Relay project file
            </a>
          </details>
        </div>
      )}
      {tab === "transcript" && (
        <div className="studio-content" {...tabPanel("studio-transcript")}>
          {!words.length ? (
            <div className="transcript-empty">
              <FileText size={28} />
              <h2>No transcript yet</h2>
              <p>
                A transcript lets you cut the video by deleting words, add
                captions, and use AI to write a title and chapters. It is made
                on this device.
              </p>
              <button
                className="btn primary"
                disabled={!!busy}
                onClick={() =>
                  void runJob(
                    "Creating the transcript",
                    `/api/videos/${sourceId}/transcribe`,
                    { model },
                  ).then(() => transcript())
                }
              >
                <Sparkles size={15} />
                Create transcript
              </button>
              <span className="small muted">
                The first time, a 40 MB speech model is downloaded.
              </span>
            </div>
          ) : (
            <>
              <p className="studio-hint">
                Click a word, then Shift-click another to select everything in
                between, or use the arrow keys and Space. Press Delete to cut
                the selection, Enter to fix a word. Crossed-out words are
                already removed; Undo brings them back.
              </p>
              <div className="transcript-toolbar">
                <input
                  aria-label="Search transcript"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Find a word…"
                />
                {sourceIds.length > 1 && (
                  <select
                    aria-label="Which footage"
                    value={sourceId}
                    onChange={(e) => setSourceId(e.target.value)}
                  >
                    {sourceIds.map((id) => (
                      <option value={id} key={id}>
                        {videos.find((v) => v.id === id)?.title || clip.title}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div
                className="transcript-words"
                role="group"
                aria-label="Transcript words"
                onKeyDown={(e) => {
                  if (
                    (e.key === "Delete" || e.key === "Backspace") &&
                    editingWord === null &&
                    wordSelection.length &&
                    !busy
                  ) {
                    e.preventDefault();
                    cutSelected();
                    return;
                  }
                  const step =
                    e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                  if (!step || editingWord !== null) return;
                  e.preventDefault();
                  const next = Math.max(
                    0,
                    Math.min(words.length - 1, focusWord + step),
                  );
                  setFocusWord(next);
                  e.currentTarget
                    .querySelector<HTMLElement>(`[data-word="${next}"]`)
                    ?.focus();
                }}
              >
                {words.map((w, i) =>
                  editingWord === i ? (
                    <input
                      key={i}
                      className="word-edit"
                      aria-label="Correct this word"
                      autoFocus
                      defaultValue={w.text.trim()}
                      size={Math.max(3, w.text.trim().length)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                        if (e.key === "Escape") {
                          e.currentTarget.value = w.text.trim();
                          e.currentTarget.blur();
                        }
                        e.stopPropagation();
                      }}
                      onBlur={(e) => {
                        const text = e.target.value.trim();
                        if (text && text !== w.text.trim())
                          saveWords(
                            words.map((word, n) =>
                              n === i ? { ...word, text } : word,
                            ),
                          );
                        setEditingWord(null);
                        // Put the keyboard back on the word that was being fixed.
                        const list = e.target.closest(".transcript-words");
                        requestAnimationFrame(() =>
                          list
                            ?.querySelector<HTMLElement>(`[data-word="${i}"]`)
                            ?.focus(),
                        );
                      }}
                    />
                  ) : (
                    <button
                      key={i}
                      data-word={i}
                      tabIndex={i === focusWord ? 0 : -1}
                      aria-pressed={wordSelection.includes(i)}
                      aria-label={
                        isCut(w) ? `${w.text.trim()}, removed` : undefined
                      }
                      className={`${wordSelection.includes(i) ? "selected" : ""} ${isCut(w) ? "cut" : ""} ${search && w.text.toLowerCase().includes(search.toLowerCase()) ? "match" : ""}`}
                      title={
                        isCut(w)
                          ? "Removed from the video. Undo brings it back."
                          : `${clock(w.start)} · Enter or double-click to fix the text`
                      }
                      onFocus={() => setFocusWord(i)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === "F2") {
                          e.preventDefault();
                          setEditingWord(i);
                        }
                      }}
                      onClick={(e) => {
                        if (isCut(w)) return;
                        if (e.shiftKey && anchorWord.current !== null) {
                          // Shift-click selects everything in between.
                          const from = Math.min(anchorWord.current, i),
                            to = Math.max(anchorWord.current, i);
                          const range = [];
                          for (let n = from; n <= to; n++)
                            if (!isCut(words[n])) range.push(n);
                          setWordSelection([
                            ...new Set([...wordSelection, ...range]),
                          ]);
                        } else {
                          anchorWord.current = i;
                          setWordSelection(
                            wordSelection.includes(i)
                              ? wordSelection.filter((n) => n !== i)
                              : [...wordSelection, i],
                          );
                        }
                        let t = 0;
                        for (const seg of project.segments) {
                          if (
                            seg.sourceId === sourceId &&
                            w.start >= seg.start &&
                            w.start < seg.end
                          ) {
                            onSeek(t + w.start - seg.start);
                            break;
                          }
                          t += seg.end - seg.start;
                        }
                      }}
                      onDoubleClick={() => setEditingWord(i)}
                    >
                      {w.text}{" "}
                    </button>
                  ),
                )}
              </div>
            </>
          )}
          <div className="actions">
            <button
              className="btn small primary"
              disabled={!wordSelection.length || !!busy}
              onClick={cutSelected}
            >
              <Scissors size={14} />
              {wordSelection.length
                ? `Cut ${wordSelection.length} selected ${wordSelection.length === 1 ? "word" : "words"}`
                : "Select words to cut"}
            </button>
            {wordSelection.length > 0 && (
              <button
                className="btn small"
                onClick={() => setWordSelection([])}
              >
                Clear selection
              </button>
            )}
          </div>
          <details className="cut-more">
            <summary>Captions files and transcript options</summary>
            <div className="add-section">
              <button
                className="btn small"
                onClick={() => importCaptions.current?.click()}
              >
                <Upload size={14} />
                Import a captions file
              </button>
              {words.length > 0 && (
                <>
                  <a
                    className="btn small"
                    href={`/api/videos/${clip.id}/captions.srt`}
                    download
                  >
                    <Download size={14} />
                    Download SRT
                  </a>
                  <a
                    className="btn small"
                    href={`/api/videos/${clip.id}/captions.vtt`}
                    download
                  >
                    <Download size={14} />
                    Download VTT
                  </a>
                </>
              )}
            </div>
            <div className="add-section">
              <select
                aria-label="Speech model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                <option value="Xenova/whisper-tiny.en">English · fast</option>
                <option value="Xenova/whisper-base.en">
                  English · more accurate
                </option>
                <option value="Xenova/whisper-tiny">Other languages</option>
              </select>
              {words.length > 0 && (
                <button
                  className="btn small"
                  disabled={!!busy}
                  onClick={() =>
                    void runJob(
                      "Creating the transcript",
                      `/api/videos/${sourceId}/transcribe`,
                      { model },
                    ).then(() => transcript())
                  }
                >
                  Create the transcript again
                </button>
              )}
            </div>
          </details>
          <input
            ref={importCaptions}
            hidden
            type="file"
            accept=".srt,.vtt,text/vtt"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void action("Importing captions", async () => {
                  await api(`/api/videos/${sourceId}/transcript`, {
                    method: "PUT",
                    body: JSON.stringify({ content: await file.text() }),
                  });
                  await transcript();
                  notify("Captions imported");
                });
            }}
          />
        </div>
      )}
      {tab === "style" && (
        <div className="studio-content look-tab" {...tabPanel("studio-style")}>
          <section className="look-card wide">
            <h2>Background</h2>
            <LookControls
              part="background"
              project={project}
              total={total}
              edit={edit}
              previewing={previewing}
              setPreviewing={setPreviewing}
              now={at}
            >
              <label>
                Shape and resolution
                <select
                  value={`${project.layout.width}x${project.layout.height}`}
                  onChange={(e) => {
                    const [w, h] = e.target.value.split("x").map(Number);
                    edit((p) => {
                      p.layout.width = w;
                      p.layout.height = h;
                    });
                  }}
                >
                  <option value="1280x720">Landscape · 720p</option>
                  {![
                    "1280x720",
                    "1920x1080",
                    "3840x2160",
                    "1080x1920",
                    "1080x1080",
                  ].includes(
                    `${project.layout.width}x${project.layout.height}`,
                  ) && (
                    <option
                      value={`${project.layout.width}x${project.layout.height}`}
                    >
                      Same as recording · {project.layout.width} ×{" "}
                      {project.layout.height}
                    </option>
                  )}
                  <option value="1920x1080">Landscape · 1080p</option>
                  <option value="3840x2160">Landscape · 4K</option>
                  <option value="1080x1920">Portrait · 1080p</option>
                  <option value="1080x1080">Square · 1080p</option>
                </select>
              </label>
              {(!project.layout.wallpaper ||
                project.layout.wallpaper === "none") && (
                <label>
                  Background colour
                  <input
                    type="color"
                    value={project.layout.background}
                    onChange={(e) =>
                      edit((p) => (p.layout.background = e.target.value))
                    }
                  />
                </label>
              )}
            </LookControls>
          </section>
          {hasCameraTrack && (
            <section className="look-card wide">
              <h2>Layout and camera</h2>
              <LookControls
                part="layout"
                project={project}
                total={total}
                edit={edit}
                previewing={previewing}
                setPreviewing={setPreviewing}
                now={at}
              />
              <div className="look-fields camera-fields">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={project.layout.camera.visible}
                    onChange={(e) =>
                      edit((p) => (p.layout.camera.visible = e.target.checked))
                    }
                  />
                  Show my camera
                </label>
                <label>
                  Shape
                  <select
                    value={project.layout.camera.shape}
                    onChange={(e) =>
                      edit(
                        (p) =>
                          (p.layout.camera.shape = e.target
                            .value as Project["layout"]["camera"]["shape"]),
                      )
                    }
                  >
                    <option value="circle">Circle</option>
                    <option value="square">Square</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </label>
              </div>
              <div className="look-fields three">
                <Slider
                  label="Left to right"
                  min={0}
                  max={0.95}
                  step={0.01}
                  value={project.layout.camera.x}
                  onChange={(v) => edit((p) => (p.layout.camera.x = v))}
                />
                <Slider
                  label="Top to bottom"
                  min={0}
                  max={0.95}
                  step={0.01}
                  value={project.layout.camera.y}
                  onChange={(v) => edit((p) => (p.layout.camera.y = v))}
                />
                <Slider
                  label="Size"
                  min={0.05}
                  max={0.6}
                  step={0.01}
                  value={project.layout.camera.size}
                  onChange={(v) => edit((p) => (p.layout.camera.size = v))}
                />
              </div>
            </section>
          )}
          <section className="look-card">
            <h2>Captions</h2>
            <label className="check-label">
              <input
                type="checkbox"
                checked={project.layout.captions}
                onChange={(e) =>
                  edit((p) => (p.layout.captions = e.target.checked))
                }
              />
              Show captions in the video
            </label>
            {project.layout.captions && !words.length && (
              <p className="studio-hint">
                Captions need a transcript. Create one in the Transcript tab.
              </p>
            )}
            {project.layout.captions && (
              <div
                className="caption-styles"
                role="radiogroup"
                aria-label="Caption style"
              >
                {(
                  [
                    ["clean", "Clean", <span key="c">Clear and simple</span>],
                    ["bold", "Bold", <span key="b">Big and bold</span>],
                    ["box", "Boxed", <span key="x">On a dark box</span>],
                    [
                      "highlight",
                      "Word by word",
                      <span key="h">
                        Word <b>by</b> word
                      </span>,
                    ],
                  ] as const
                ).map(([id, label, sample]) => (
                  <button
                    type="button"
                    key={id}
                    {...radio((project.layout.captionStyle || "clean") === id)}
                    className={`${id} ${(project.layout.captionStyle || "clean") === id ? "selected" : ""}`}
                    onClick={() => edit((p) => (p.layout.captionStyle = id))}
                  >
                    {sample}
                  </button>
                ))}
              </div>
            )}
          </section>
          <section className="look-card">
            <h2>Sound</h2>
            <div className="look-fields">
              <Slider
                label="Your voice"
                min={0}
                max={2}
                step={0.05}
                value={project.layout.audio.microphone}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => edit((p) => (p.layout.audio.microphone = v))}
              />
              <Slider
                label="Computer sound"
                min={0}
                max={2}
                step={0.05}
                value={project.layout.audio.system}
                format={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => edit((p) => (p.layout.audio.system = v))}
              />
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={project.layout.audio.normalize}
                  onChange={(e) =>
                    edit((p) => (p.layout.audio.normalize = e.target.checked))
                  }
                />
                Even out the volume
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={project.layout.audio.denoise}
                  onChange={(e) =>
                    edit((p) => (p.layout.audio.denoise = e.target.checked))
                  }
                />
                Reduce background noise
              </label>
            </div>
          </section>
          <section className="look-card wide">
            <h2>Titles</h2>
            <p className="studio-hint">
              Add an opening title, your name, or a label for each part.
            </p>
            <div className="title-add">
              {(
                [
                  ["title", "Title card", "Your title", "A short subtitle"],
                  ["lowerthird", "Name and role", "Your name", "Your role"],
                  ["chapter", "Chapter label", "01 · Chapter", ""],
                ] as const
              ).map(([type, label, text, sub]) => (
                <button
                  className="btn small"
                  key={type}
                  onClick={() =>
                    edit((p) =>
                      p.overlays.push({
                        id: freshId(),
                        type,
                        start: at(),
                        end: Math.min(at() + (type === "title" ? 3 : 5), total),
                        x: 0.1,
                        y: 0.1,
                        w: 0.3,
                        h: 0.15,
                        scale: 1.8,
                        text,
                        sub,
                        color: "#d6f475",
                      }),
                    )
                  }
                >
                  <Plus size={12} />
                  {label}
                </button>
              ))}
            </div>
            {project.overlays.map((o, i) =>
              isTitle(o.type) ? overlayRow(o, i) : null,
            )}
          </section>
          <section className="look-card wide">
            <div className="section-heading">
              <h2>Zoom and highlights</h2>
              <div className="actions">
                {project.overlays.some((o) => o.auto) && (
                  <button
                    className="text-button small"
                    onClick={() =>
                      edit(
                        (p) => (p.overlays = p.overlays.filter((o) => !o.auto)),
                      )
                    }
                  >
                    Remove auto-zooms
                  </button>
                )}
                <button
                  className="text-button small"
                  onClick={() =>
                    void action("Finding key moments", async () => {
                      const effects = await api<Project["overlays"]>(
                        `/api/videos/${clip.id}/focus-suggestions`,
                      );
                      edit((p) => p.overlays.push(...effects));
                      notify(
                        effects.length
                          ? `Added ${effects.length} zoom${effects.length === 1 ? "" : "s"} where you paused to point.`
                          : "No new key moments found. Pointer data comes from Mac app recordings; add a zoom by hand.",
                      );
                    })
                  }
                >
                  Find key moments to zoom
                </button>
              </div>
            </div>
            <p className="studio-hint">
              Zoom in on a detail, point at it, or blur something private.
            </p>
            <div className="effect-add">
              {(
                [
                  ["zoom", "Zoom"],
                  ["text", "Text"],
                  ["arrow", "Arrow"],
                  ["box", "Outline"],
                  ["blur", "Blur"],
                  ["cursor", "Dot"],
                ] as const
              ).map(([type, effectLabel]) => (
                <button
                  className="btn small"
                  key={type}
                  onClick={() =>
                    edit((p) =>
                      p.overlays.push({
                        id: freshId(),
                        type,
                        start: at(),
                        end: Math.min(at() + 3, total),
                        x: type === "zoom" ? 0.5 : 0.1,
                        y: type === "zoom" ? 0.5 : 0.15,
                        w: 0.3,
                        h: 0.15,
                        scale: 1.8,
                        text: type === "text" ? "Your text" : "",
                        color: "#d6f475",
                      }),
                    )
                  }
                >
                  <Plus size={12} />
                  {effectLabel}
                </button>
              ))}
            </div>
            {project.overlays.map((o, i) =>
              !isTitle(o.type) ? overlayRow(o, i) : null,
            )}
          </section>
          <section className="look-card wide">
            <h2>Button under the video</h2>
            <p className="studio-hint">
              Viewers see this button on the share page, for example “Book a
              call”.
            </p>
            <div className="look-fields">
              <label className="field">
                Button text
                <input
                  placeholder="Book a call"
                  value={project.cta.label}
                  maxLength={80}
                  onChange={(e) => edit((p) => (p.cta.label = e.target.value))}
                />
              </label>
              <label className="field">
                Link
                <input
                  type="url"
                  placeholder="https://…"
                  value={project.cta.url}
                  onChange={(e) => edit((p) => (p.cta.url = e.target.value))}
                />
              </label>
            </div>
          </section>
        </div>
      )}
      {tab === "ai" && (
        <div className="studio-content look-tab" {...tabPanel("studio-ai")}>
          <AssistCard
            clip={clip}
            total={total}
            busy={!!busy}
            hasTranscript={words.length > 0}
            edit={edit}
            notify={notify}
            onDetails={onRendered}
            onOutline={(next) => setOutline(next.outline || {})}
            setError={setError}
          />
          {outline.summary && (
            <div className="generated-outline">
              <h2>Summary and chapters</h2>
              <textarea
                className="outline-summary"
                aria-label="Video summary"
                onBlur={saveOutline}
                rows={5}
                value={outline.summary || ""}
                onChange={(e) =>
                  setOutline({ ...outline, summary: e.target.value })
                }
              />
              <label className="field">
                Action items
                <textarea
                  aria-label="Video action items"
                  onBlur={saveOutline}
                  rows={3}
                  value={(outline.actionItems || []).join("\n")}
                  onChange={(e) =>
                    setOutline({
                      ...outline,
                      actionItems: e.target.value.split("\n"),
                    })
                  }
                />
              </label>
              {outline.chapters?.map((c, i) => (
                <button
                  className="chapter-link"
                  key={i}
                  onClick={() => onSeek(c.time)}
                >
                  <span>{clock(c.time)}</span>
                  {c.title}
                </button>
              ))}
              {!!outline.actionItems?.length && (
                <>
                  <h2>Action items</h2>
                  <ul>
                    {outline.actionItems.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <section className="look-card">
            <h2>Turn this video into a document</h2>
            <p className="studio-hint">
              Makes a first draft from the transcript and your notes. Check it
              before you send it.
            </p>
            <div className="transcript-toolbar">
              <select
                aria-label="Document type"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="message">Message or email</option>
                <option value="sop">Step-by-step guide</option>
                <option value="bug">Bug report</option>
                <option value="pr">Pull request description</option>
                <option value="agent">Prompt for a coding agent</option>
              </select>
              <button
                className="btn small"
                onClick={() =>
                  void action("Writing draft", async () =>
                    setContext(
                      (
                        await api<{ content: string }>(
                          `/api/videos/${clip.id}/context`,
                          { method: "POST", body: JSON.stringify({ format }) },
                        )
                      ).content,
                    ),
                  )
                }
              >
                <FileText size={14} />
                Create draft
              </button>
            </div>
            {context && (
              <>
                <textarea
                  className="context-draft"
                  aria-label="Draft document"
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                />
                <button
                  className="btn small"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(context)
                      .then(() => notify("Draft copied"))
                  }
                >
                  Copy draft
                </button>
              </>
            )}
          </section>
          <details className="cut-more">
            <summary>Summarise without an AI account</summary>
            <div className="cut-more-body">
              <div className="transcript-toolbar">
                <select
                  aria-label="Where to summarise"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                >
                  <option value="local">On this computer</option>
                  <option value="ollama">Ollama</option>
                </select>
                <button
                  className="btn small"
                  disabled={!!busy || (provider !== "local" && !consent)}
                  onClick={() =>
                    void runJob(
                      "Creating summary and chapters",
                      `/api/videos/${clip.id}/summarize`,
                      { provider, consent },
                    )
                  }
                >
                  <Sparkles size={14} />
                  Write summary and chapters
                </button>
              </div>
              {provider !== "local" ? (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  Send this transcript to your Ollama server
                </label>
              ) : (
                <p className="studio-hint">
                  Works without an account. The first run downloads a small
                  model; your recording and transcript never leave this
                  computer.
                </p>
              )}
            </div>
          </details>
        </div>
      )}
    </section>
  );
});
