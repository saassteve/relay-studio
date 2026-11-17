import { radio, tab as tabAttrs, tabPanel } from "./Modal";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { DraftPlayer, type DraftPlayerHandle } from "./DraftPlayer";
import { Timeline } from "./Timeline";
import { LookControls, NumberField, Slider } from "./LookPanel";
import { insertSpan, removeSpan, swapSpans } from "./retime";
import { AssistCard } from "./AssistCard";
import {
  DEFAULT_TEXT_SIZE,
  MAX_EFFECTS,
  TEXT_ANIMATIONS,
  TEXT_STYLES,
  ZOOM_MOTIONS,
} from "../shared/editor-effects.mjs";
const isTitle = (type: string) =>
  type === "title" || type === "lowerthird" || type === "chapter";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  FileText,
  LoaderCircle,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Play,
  Palette,
  Send,
  WandSparkles,
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
type Overlay = Project["overlays"][number];
const EFFECTS = ["zoom", "text", "arrow", "box", "blur", "cursor"] as const;
const EFFECT_CHOICES = {
  smooth: "Smooth",
  quick: "Quick",
  cut: "Instant",
  label: "Dark label",
  outline: "Outlined",
  plain: "Plain",
  none: "None",
  fade: "Fade in and out",
};
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
// The ways an arrow can point, as in server/studio/project.mjs.
const ARROWS = [
  ["→", "Right"],
  ["←", "Left"],
  ["↑", "Up"],
  ["↓", "Down"],
  ["↗", "Up and right"],
  ["↘", "Down and right"],
  ["↙", "Down and left"],
  ["↖", "Up and left"],
] as const;
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
    [focusWord, setFocusWord] = useState(0),
    [editingWord, setEditingWord] = useState<number | null>(null),
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
    [format, setFormat] = useState("message"),
    [picked, setPicked] = useState<{ id: string; reveal?: boolean } | null>(
      null,
    );
  const workbench = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!picked || picked.reveal === false) return;
    workbench.current
      ?.querySelector(".stage")
      ?.scrollIntoView({ block: "start" });
  }, [picked]);
  const anchorWord = useRef<number | null>(null),
    marker = useRef<HTMLElement>(null),
    importCaptions = useRef<HTMLInputElement>(null);
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
    setFocusWord(0);
    anchorWord.current = null;
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
  // Always the newest project, including edits made since this render.
  const latest = useRef(project);
  latest.current = project;
  const edit = (fn: (p: Project) => void) => {
    if (!latest.current) return;
    const next = structuredClone(latest.current);
    fn(next);
    latest.current = next;
    setProject(next);
    setDirty(true);
  };
  const total = project?.segments.reduce((n, s) => n + s.end - s.start, 0) || 0;
  const trackTime = useCallback(
    (t: number) => {
      if (marker.current && total)
        marker.current.style.left = `${Math.min(100, (t / total) * 100)}%`;
      onTime?.(t);
    },
    [total, onTime],
  );
  // Where a section began and ended when a trim handle was picked up.
  const trimFrom = useRef<{
    i: number;
    sourceId: string;
    start: number;
    end: number;
  } | null>(null);
  // Whether the message on screen is about a save that failed.
  const saveError = useRef(false);
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
      if (saveError.current) {
        saveError.current = false;
        setError("");
      }
      return result;
    } catch (e) {
      setSaveFailed(true);
      saveError.current = true;
      throw e;
    } finally {
      setSaving(false);
    }
  };
  // Whether a mouse button, a finger or a key is being held down anywhere.
  const held = useRef(false);
  useEffect(() => {
    const down = () => (held.current = true),
      up = () => (held.current = false);
    const events: [string, () => void][] = [
      ["pointerdown", down],
      ["keydown", down],
      ["pointerup", up],
      ["pointercancel", up],
      ["keyup", up],
      ["blur", up],
    ];
    for (const [name, fn] of events) addEventListener(name, fn, true);
    return () => {
      for (const [name, fn] of events) removeEventListener(name, fn, true);
    };
  }, []);
  // Edits save themselves a moment after you stop.
  useEffect(() => {
    if (!dirty || !project) return;
    const timer = setTimeout(() => {
      if (trimFrom.current) {
        // A trim that is still being dragged saves once, when it is let go.
        // One that nothing is holding (a value set by an assistive tool, say)
        // has ended without saying so: finish it, and it saves next time round.
        if (!held.current) settleTrim();
        return;
      }
      void persist().catch((e) => setError((e as Error).message));
    }, 900);
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
  // How long each piece of added footage really is. A video's listed length is its
  // published length, which can be shorter than the footage behind it.
  const [footage, setFootage] = useState<Record<string, number>>({});
  useEffect(() => {
    for (const id of new Set(project?.segments.map((s) => s.sourceId)))
      if (id !== clip.id && footage[id] === undefined)
        void api<ProjectState>(`/api/videos/${id}/project`)
          .then((s) => setFootage((f) => ({ ...f, [id]: s.sourceDuration })))
          .catch(() => setFootage((f) => ({ ...f, [id]: 0 })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.segments, clip.id]);
  // If the footage a transcript belongs to is removed, go back to the main one.
  useEffect(() => {
    if (
      project &&
      sourceId !== clip.id &&
      !project.segments.some((s) => s.sourceId === sourceId)
    )
      setSourceId(clip.id);
  }, [project, sourceId, clip.id]);
  // One long-running thing at a time, so a quick action can't hide a slow one.
  const working = useRef(false);
  const action = async (label: string, fn: () => Promise<void>) => {
    if (working.current) return false;
    working.current = true;
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
      working.current = false;
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
        } else if (complete.type !== "render") {
          // Work on footage added from another video, such as its transcript.
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
  // Every saved edit is a step in one history, kept with the video.
  const canUndo = dirty || Boolean(state?.canUndo),
    canRedo = !dirty && Boolean(state?.canRedo);
  const history = async (direction: "undo" | "redo") => {
    if (!project || !(direction === "undo" ? canUndo : canRedo)) return;
    await action(direction === "undo" ? "Undo" : "Redo", async () => {
      // An edit that hasn't saved yet becomes its own step first.
      if (dirty) await persist();
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
      setFootage((f) => ({ ...f, [addId]: s.sourceDuration }));
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
      const sent = latest.current;
      await persist();
      const j = await api<Job>(`/api/videos/${clip.id}/render`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await awaitJob(j, setJob);
      onRendered(await api<Clip>(`/api/videos/${clip.id}`));
      const s = await api<ProjectState>(`/api/videos/${clip.id}/project`);
      setState(s);
      // Edits made while the video was rendering stay, and save as usual.
      if (latest.current === sent) {
        setProject(s.project);
        setDirty(false);
      }
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
      if (document.querySelector('[role="dialog"],[role="alertdialog"]'))
        return;
      e.preventDefault();
      void historyRef.current(e.shiftKey ? "redo" : "undo");
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (!project || !state)
    return (
      <section className="studio-workbench">
        {error ? (
          <>
            <p className="error" role="alert">
              The editing tools didn’t load. {error}
            </p>
            <button
              className="btn small"
              onClick={() => {
                setError("");
                void load().catch((e) => setError((e as Error).message));
              }}
            >
              Try again
            </button>
          </>
        ) : (
          <LoaderCircle className="spin" size={18} aria-label="Loading" />
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
  // Dragging a trim handle changes the footage under later effects. When the handle
  // is let go, they are moved to stay over the footage they were put on.
  const settleTrim = () => {
    const from = trimFrom.current;
    trimFrom.current = null;
    const now = latest.current?.segments[from?.i ?? -1];
    if (!from || !now || now.sourceId !== from.sourceId) return;
    const offset = sectionStart(from.i),
      head = now.start - from.start,
      tail = now.end - from.end;
    // Also when the handle ended where it began: saving waited for the gesture.
    edit((p) => {
      // The end first, measured on the old timeline, so the two don't interfere.
      if (tail < 0) removeSpan(p, offset + now.end - from.start, -tail);
      if (tail > 0) insertSpan(p, offset + from.end - from.start, tail);
      if (head > 0) removeSpan(p, offset, head);
      if (head < 0) insertSpan(p, offset, -head);
    });
  };
  const trimGesture = {
    onPointerUp: settleTrim,
    onKeyUp: settleTrim,
    onBlur: settleTrim,
  };
  // How long the footage behind a section is.
  const footageLength = (section: { sourceId: string; end: number }) =>
    Math.max(
      section.end,
      section.sourceId === clip.id
        ? state.sourceDuration
        : (footage[section.sourceId] ??
            videos.find((v) => v.id === section.sourceId)?.duration ??
            0),
    );
  // Move one end of a section, from the trim sliders or the timeline. Every call
  // until settleTrim belongs to one gesture, which is one step to undo.
  const trimSection = (i: number, edge: "start" | "end", to: number) => {
    if (trimFrom.current && trimFrom.current.i !== i) settleTrim();
    const now = latest.current?.segments[i];
    if (!now) return;
    const value =
      edge === "start"
        ? Math.max(0, Math.min(to, now.end - 0.2))
        : Math.min(footageLength(now), Math.max(to, now.start + 0.2));
    if (value === now[edge]) return;
    trimFrom.current ??= { i, ...now };
    edit((p) => (p.segments[i][edge] = value));
    setSelected(i);
    // Show the new first or last frame while the handle moves.
    requestAnimationFrame(() =>
      onSeek(
        sectionStart(i) +
          (edge === "start" ? 0 : Math.max(0, value - now.start - 0.05)),
      ),
    );
  };
  // Put a section somewhere else in the order, one neighbour at a time, so titles
  // and effects stay over the footage they were put on.
  const moveSection = (from: number, to: number) => {
    const count = latest.current?.segments.length ?? 0;
    if (from === to || Math.min(from, to) < 0 || Math.max(from, to) >= count)
      return;
    edit((p) => {
      const way = to > from ? 1 : -1;
      for (let i = from; i !== to; i += way) {
        const at = Math.min(i, i + way);
        const [first, second] = [p.segments[at], p.segments[at + 1]];
        p.segments[at] = second;
        p.segments[at + 1] = first;
        swapSpans(
          p,
          p.segments.slice(0, at).reduce((n, x) => n + x.end - x.start, 0),
          first.end - first.start,
          second.end - second.start,
        );
      }
    });
    setSelected(to);
  };
  const removeSection = (i: number) => {
    if (project.segments.length < 2 || !project.segments[i]) return;
    edit((p) => {
      const [gone] = p.segments.splice(i, 1);
      removeSpan(p, sectionStart(i), gone.end - gone.start);
    });
    setSelected(i <= selected ? Math.max(0, selected - 1) : selected);
  };
  // Where a moment in some footage sits in the edited video, or null if it was cut.
  const onTimeline = (source: string, at: number) => {
    let t = 0;
    for (const seg of project.segments) {
      if (seg.sourceId === source && at >= seg.start && at < seg.end)
        return t + at - seg.start;
      t += seg.end - seg.start;
    }
    return null;
  };
  // How long the footage behind the selected section is.
  const selectedMax = footageLength(selectedSection);
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
  // Cut the section under the playhead in two, from the button or the S key.
  const splitHere = () => {
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
    } else notify("Move the playhead inside a section to split it.");
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
  // Leave a playable range even when adding an effect at the final frame.
  const rangeAt = (time: number, length: number) => {
    const start = Math.max(0, Math.min(time, total - 0.5));
    return { start, end: Math.min(total, start + length) };
  };
  const at = () =>
    +Math.max(0, Math.min(total - 1, player.current?.time() ?? 0)).toFixed(1);
  const showEffect = (o: Overlay) => {
    player.current?.pause();
    onSeek(o.start + Math.min(0.5, (o.end - o.start) / 2));
  };
  const addOverlay = (
    type: Overlay["type"],
    text = "",
    sub?: string,
    original?: Overlay,
  ) => {
    const p = latest.current;
    if (!p || p.overlays.length >= MAX_EFFECTS) return;
    const time = Math.max(player.current?.time() ?? 0, original?.end ?? 0);
    const length = original
      ? original.end - original.start
      : type === "lowerthird" || type === "chapter"
        ? 5
        : 3;
    const o: Overlay = {
      type,
      x: type === "zoom" ? 0.5 : 0.1,
      y: type === "zoom" ? 0.5 : 0.15,
      w: 0.3,
      h: 0.15,
      scale: 1.8,
      text,
      sub,
      color: "#d6f475",
      ...original,
      ...rangeAt(time, length),
      id: freshId(),
      auto: undefined,
    };
    edit((p) => p.overlays.push(o));
    showEffect(o);
    setPicked({ id: o.id });
  };
  const pickedIndex = project.overlays.findIndex((o) => o.id === picked?.id);
  const atEffectLimit = project.overlays.length >= MAX_EFFECTS;
  const overlayRow = (o: Overlay, i: number) => (
    <div
      className={`effect-row${picked?.id === o.id ? " is-picked" : ""}`}
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
              : o.type === "text"
                ? "Double-click the text to edit. Drag to move."
                : "Drag in the preview to place it."}
          </small>
        )}
      </strong>
      {o.type === "text" && (
        <details className="inspector-copy">
          <summary>Edit wording</summary>
          <textarea
            aria-label="Words"
            rows={2}
            value={o.text}
            maxLength={500}
            onChange={(e) => edit((p) => (p.overlays[i].text = e.target.value))}
          />
        </details>
      )}
      {isTitle(o.type) && (
        <label className="effect-text">
          {o.type === "lowerthird"
            ? "Name"
            : o.type === "chapter"
              ? "Label"
              : "Title"}
          <input
            value={o.text}
            maxLength={500}
            onChange={(e) => edit((p) => (p.overlays[i].text = e.target.value))}
          />
        </label>
      )}
      {o.type !== "zoom" && o.type !== "blur" && (
        <label>
          Colour
          <input
            aria-label={`${OVERLAY_NAMES[o.type]} colour`}
            title="Colour"
            type="color"
            value={o.color}
            onChange={(e) =>
              edit((p) => (p.overlays[i].color = e.target.value))
            }
          />
        </label>
      )}
      {o.type === "text" && (
        <>
          <label>
            Text style
            <select
              value={o.textStyle || "label"}
              onChange={(e) =>
                edit(
                  (p) =>
                    (p.overlays[i].textStyle = e.target
                      .value as Overlay["textStyle"]),
                )
              }
            >
              {TEXT_STYLES.map((style) => (
                <option key={style} value={style}>
                  {EFFECT_CHOICES[style]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Text size (% of frame height)
            <NumberField
              min={2}
              max={12}
              step="0.5"
              value={
                o.textSize
                  ? o.textSize * 100
                  : Math.max(18 / project.layout.height, DEFAULT_TEXT_SIZE) *
                    100
              }
              onCommit={(n) => edit((p) => (p.overlays[i].textSize = n / 100))}
            />
          </label>
          <label>
            Text animation
            <select
              value={o.animation || "none"}
              onChange={(e) =>
                edit(
                  (p) =>
                    (p.overlays[i].animation = e.target
                      .value as Overlay["animation"]),
                )
              }
            >
              {TEXT_ANIMATIONS.map((animation) => (
                <option key={animation} value={animation}>
                  {EFFECT_CHOICES[animation]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {o.type === "arrow" && (
        <label>
          Points
          <select
            value={o.text || "→"}
            onChange={(e) => edit((p) => (p.overlays[i].text = e.target.value))}
          >
            {ARROWS.map(([arrow, way]) => (
              <option key={arrow} value={arrow}>
                {arrow} {way}
              </option>
            ))}
          </select>
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
      {o.type === "zoom" && (
        <>
          <label>
            Zoom ×
            <NumberField
              min={1}
              max={4}
              step=".1"
              value={o.scale}
              onCommit={(n) => edit((p) => (p.overlays[i].scale = n))}
            />
          </label>
          <label>
            Zoom motion
            <select
              value={o.motion || "smooth"}
              onChange={(e) =>
                edit(
                  (p) =>
                    (p.overlays[i].motion = e.target
                      .value as Overlay["motion"]),
                )
              }
            >
              {ZOOM_MOTIONS.map((motion) => (
                <option key={motion} value={motion}>
                  {EFFECT_CHOICES[motion]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <details className="inspector-timing">
        <summary>Timing and position</summary>
        <div>
          {" "}
          <label>
            Starts at (sec)
            <NumberField
              min={0}
              max={total}
              step=".1"
              value={o.start}
              valid={(n) => n < o.end}
              onCommit={(n) => edit((p) => (p.overlays[i].start = n))}
            />
          </label>
          <label>
            Ends at (sec)
            <NumberField
              min={0}
              max={total}
              step=".1"
              value={o.end}
              valid={(n) => n > o.start}
              onCommit={(n) => edit((p) => (p.overlays[i].end = n))}
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
                    <NumberField
                      min={key === "x" || key === "y" ? 0 : 1}
                      max={
                        key === "x" || key === "y"
                          ? o.type === "zoom"
                            ? 100
                            : 95
                          : 100
                      }
                      value={Math.round(o[key] * 100)}
                      onCommit={(n) =>
                        edit((p) => (p.overlays[i][key] = n / 100))
                      }
                    />
                  </label>
                ))}
              </div>
            </details>
          )}
          <span className="effect-actions">
            <button
              className="btn"
              aria-label={`Start here: ${OVERLAY_NAMES[o.type]}`}
              onClick={() =>
                edit((p) => {
                  Object.assign(
                    p.overlays[i],
                    rangeAt(player.current?.time() ?? 0, o.end - o.start),
                  );
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
                  p.overlays[i].end = Math.min(
                    total,
                    Math.max(o.start + 0.1, player.current?.time() ?? 0),
                  );
                })
              }
            >
              End here
            </button>
            <button
              className="btn"
              aria-label={`Go to it: ${OVERLAY_NAMES[o.type]}`}
              onClick={() => {
                setPicked({ id: o.id, reveal: false });
                showEffect(o);
                workbench.current
                  ?.querySelector(".stage")
                  ?.scrollIntoView({ block: "start" });
              }}
            >
              Go to it
            </button>
          </span>
        </div>
      </details>
      <button
        className="icon-button"
        title="Duplicate after this effect or at the playhead"
        aria-label={`Duplicate ${OVERLAY_NAMES[o.type]}`}
        disabled={atEffectLimit}
        onClick={() => addOverlay(o.type, o.text, o.sub, o)}
      >
        <Copy size={15} />
      </button>
      <button
        className="icon-button danger"
        aria-label={`Remove ${OVERLAY_NAMES[o.type]}`}
        onClick={() => {
          const timeline =
            workbench.current?.querySelector<HTMLElement>(".tl-clips button");
          edit((p) => p.overlays.splice(i, 1));
          setPicked(null);
          timeline?.focus({ preventScroll: true });
        }}
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
  return (
    <section
      className="studio-workbench"
      ref={workbench}
      style={{
        ["--ratio" as string]: project.layout.width / project.layout.height,
      }}
    >
      <div>
        <div className="stage">
          <DraftPlayer
            ref={player}
            project={project}
            videoId={clip.id}
            hasCamera={hasCameraTrack}
            focusOverlayId={picked?.id}
            onPickOverlay={(id) => setPicked({ id, reveal: false })}
            words={sourceId === clip.id ? words : []}
            onTime={trackTime}
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
            onTrim={trimSection}
            onTrimEnd={settleTrim}
            onMove={moveSection}
            onRemove={removeSection}
            onSplit={splitHere}
            pickedId={picked?.id}
            onPick={(key) => {
              const o = project.overlays.find((effect) => effect.id === key);
              if (o) showEffect(o);
              setTab(!o || isTitle(o.type) ? "style" : "effects");
              setPicked({ id: key, reveal: false });
            }}
          />
        </div>
        {pickedIndex >= 0 &&
          overlayRow(project.overlays[pickedIndex], pickedIndex)}
        <div className="studio-status">
          <div className="actions">
            <button
              className="icon-button"
              aria-label="Undo"
              title={`Undo (${MOD}Z)`}
              disabled={!canUndo || Boolean(busy)}
              onClick={() => void history("undo")}
            >
              <Undo2 size={17} />
            </button>
            <button
              className="icon-button"
              aria-label="Redo"
              title={`Redo (Shift ${MOD}Z)`}
              disabled={!canRedo || Boolean(busy)}
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
              ["effects", "Effects", WandSparkles],
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
            it where the video is paused, or remove it. On the timeline, drag
            the end of a section to trim it, or drag a section sideways to
            change the order. Nothing is ever deleted from the original
            recording.
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
                {...trimGesture}
                onChange={(e) =>
                  trimSection(selected, "start", +e.target.value)
                }
              />
              <input
                type="range"
                aria-label="Section end"
                aria-valuetext={clock(selectedSection.end)}
                min={0}
                max={selectedMax}
                step={0.05}
                value={selectedSection.end}
                {...trimGesture}
                onChange={(e) => trimSection(selected, "end", +e.target.value)}
              />
            </div>
            <div className="cut-actions">
              <button
                className="btn small"
                onClick={() => {
                  const here = playhead();
                  if (here.source < here.section.end - 0.2)
                    edit((p) => {
                      p.segments[here.i].start = here.source;
                      removeSpan(
                        p,
                        sectionStart(here.i),
                        here.source - here.section.start,
                      );
                    });
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
                    edit((p) => {
                      p.segments[here.i].end = here.source;
                      removeSpan(
                        p,
                        sectionStart(here.i) + here.source - here.section.start,
                        here.section.end - here.source,
                      );
                    });
                  setSelected(here.i);
                }}
              >
                End here
              </button>
              <button className="btn small" onClick={splitHere}>
                <Scissors size={14} />
                Split here
              </button>
              <span className="cut-spacer" />
              <button
                className="btn small"
                aria-label="Move section earlier"
                disabled={selected === 0}
                onClick={() => moveSection(selected, selected - 1)}
              >
                <ArrowUp size={14} />
                Earlier
              </button>
              <button
                className="btn small"
                aria-label="Move section later"
                disabled={selected === project.segments.length - 1}
                onClick={() => moveSection(selected, selected + 1)}
              >
                <ArrowDown size={14} />
                Later
              </button>
              <button
                className="btn small danger"
                disabled={project.segments.length === 1}
                onClick={() => removeSection(selected)}
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
                      // Suggestions are timed on the footage, not the edit.
                      const at = onTimeline(s.sourceId, s.start);
                      if (at === null)
                        notify("That part has already been cut.");
                      else onSeek(Math.max(0, at - 1));
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
                  ).then(() =>
                    transcript().catch((e) => setError((e as Error).message)),
                  )
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
                        const at = onTimeline(sourceId, w.start);
                        if (at !== null) onSeek(at);
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
                    ).then(() =>
                      transcript().catch((e) => setError((e as Error).message)),
                    )
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
                      p.layout.padding = Math.min(
                        p.layout.padding,
                        Math.floor(Math.min(w, h) / 3),
                      );
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
                  disabled={atEffectLimit}
                  onClick={() => addOverlay(type, text, sub)}
                >
                  <Plus size={12} />
                  {label}
                </button>
              ))}
            </div>
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
      {tab === "effects" && (
        <div
          className="studio-content look-tab"
          {...tabPanel("studio-effects")}
        >
          <section className="look-card wide">
            <div className="section-heading">
              <h2>Zoom and highlights</h2>
              <div className="actions">
                {project.overlays.some((o) => o.auto) && (
                  <button
                    className="text-button small"
                    onClick={() =>
                      edit((p) => {
                        p.overlays = p.overlays.filter((o) => !o.auto);
                      })
                    }
                  >
                    Remove auto-zooms
                  </button>
                )}
                <button
                  className="text-button small"
                  disabled={atEffectLimit || Boolean(busy)}
                  onClick={() =>
                    void action("Finding key moments", async () => {
                      const snapshot = latest.current;
                      if (!snapshot) return;
                      const effects = await api<Overlay[]>(
                        `/api/videos/${clip.id}/focus-suggestions`,
                        { method: "POST", body: JSON.stringify(snapshot) },
                      );
                      const current = latest.current;
                      if (
                        !current ||
                        JSON.stringify(current.segments) !==
                          JSON.stringify(snapshot.segments)
                      ) {
                        notify(
                          "The cut changed. Find key moments again to use the new timing.",
                        );
                        return;
                      }
                      const zooms = current.overlays.filter(
                        (o) => o.type === "zoom",
                      );
                      const additions = effects
                        .filter(
                          (z) =>
                            !zooms.some(
                              (o) => z.start < o.end && o.start < z.end,
                            ),
                        )
                        .slice(0, MAX_EFFECTS - current.overlays.length);
                      if (additions.length)
                        edit((p) => p.overlays.push(...additions));
                      notify(
                        additions.length
                          ? `Added ${additions.length} automatic zoom${additions.length === 1 ? "" : "s"}.`
                          : "No new key moments found. For automatic zooms, move the pointer to a detail and pause during a Mac recording.",
                      );
                    })
                  }
                >
                  Find key moments to zoom
                </button>
              </div>
            </div>
            <p className="studio-hint">
              Add an effect at the playhead. Drag its bar to move it, or drag an
              end to change its duration.
            </p>
            {atEffectLimit && (
              <p className="studio-hint" role="status">
                This video has the maximum of {MAX_EFFECTS} effects.
              </p>
            )}
            <div className="effect-add">
              {EFFECTS.map((type) => (
                <button
                  className="btn small"
                  key={type}
                  disabled={atEffectLimit}
                  onClick={() =>
                    addOverlay(
                      type,
                      type === "text"
                        ? "Your text"
                        : type === "arrow"
                          ? "→"
                          : "",
                    )
                  }
                >
                  <Plus size={12} />
                  {OVERLAY_NAMES[type]}
                </button>
              ))}
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
