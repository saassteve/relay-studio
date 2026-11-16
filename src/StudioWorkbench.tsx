import { useEffect, useRef, useState } from "react";
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
export function StudioWorkbench({
  clip,
  onRendered,
  notify,
  onSeek,
}: {
  clip: Clip;
  onRendered: (v: Clip) => void;
  notify: (message: string) => void;
  onSeek: (time: number) => void;
}) {
  const [state, setState] = useState<ProjectState | null>(null),
    [project, setProject] = useState<Project | null>(null),
    [tab, setTab] = useState("edit"),
    [videos, setVideos] = useState<Clip[]>([]),
    [addId, setAddId] = useState(""),
    [selectedRaw, setSelected] = useState(0),
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
    [format, setFormat] = useState("agent");
  const undo = useRef<Project[]>([]),
    redo = useRef<Project[]>([]),
    importCaptions = useRef<HTMLInputElement>(null),
    preview = useRef<HTMLDivElement>(null);
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
  const change = (next: Project) => {
    if (project) undo.current.push(structuredClone(project));
    redo.current = [];
    setProject(next);
    setDirty(true);
  };
  const edit = (fn: (p: Project) => void) => {
    if (!project) return;
    const next = structuredClone(project);
    fn(next);
    change(next);
  };
  const total = project?.segments.reduce((n, s) => n + s.end - s.start, 0) || 0;
  const persist = async () => {
    if (!project) return;
    const result = await api<ProjectState>(`/api/videos/${clip.id}/project`, {
      method: "PUT",
      body: JSON.stringify(project),
    });
    setState(result);
    setDirty(false);
    notify("Editable project saved");
    return result;
  };
  const action = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
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
  const history = async (direction: "undo" | "redo") => {
    if (!project) return;
    const from = direction === "undo" ? undo : redo,
      to = direction === "undo" ? redo : undo;
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
      notify("Cuts saved. Original source tracks are intact.");
    }
  };
  if (!project || !state)
    return (
      <section className="studio-workbench">
        <LoaderCircle className="spin" size={18} />
        {error && <p className="error">{error}</p>}
      </section>
    );
  const sourceIds = [
    ...new Set([clip.id, ...project.segments.map((s) => s.sourceId)]),
  ];
  const selectedSection =
    project.segments[Math.min(selected, project.segments.length - 1)];
  return (
    <section className="studio-workbench">
      <div className="studio-top">
        <div>
          <span className="eyebrow">YOUR EDITABLE STUDIO</span>
          <h2>Make the first take the good take.</h2>
        </div>
        <div className="actions">
          <button
            className="icon-button"
            aria-label="Undo edit"
            disabled={!undo.current.length && !state.canUndo}
            onClick={() => void history("undo")}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            aria-label="Redo edit"
            disabled={!redo.current.length && !state.canRedo}
            onClick={() => void history("redo")}
          >
            <Redo2 size={16} />
          </button>
          <span className="small muted">
            {clock(total)} · {project.segments.length} sections
          </span>
        </div>
      </div>
      <div className="studio-tabs">
        {(
          [
            ["edit", "Sections", Scissors],
            ["transcript", "Transcript", FileText],
            ["style", "Presentation", Palette],
            ["ai", "AI & context", Sparkles],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id as string}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id as string)}
          >
            {typeof Icon !== "string" && <Icon size={15} />} {label as string}
          </button>
        ))}
      </div>
      {tab === "edit" && (
        <div className="studio-content">
          <p className="studio-hint">
            Each section references original footage. Save a project at any
            time; render to update the watch page.
          </p>
          <div className="section-timeline">
            {project.segments.map((s, i) => (
              <button
                key={`${i}-${s.sourceId}`}
                className={i === selected ? "selected" : ""}
                onClick={() => {
                  setSelected(i);
                  setCutStart(s.start);
                  setCutEnd(Math.min(s.end, s.start + 1));
                  onSeek(
                    project.segments
                      .slice(0, i)
                      .reduce((n, s) => n + s.end - s.start, 0),
                  );
                }}
              >
                <span>{i + 1}</span>
                <strong>
                  {videos.find((v) => v.id === s.sourceId)?.title ||
                    "Original footage"}
                </strong>
                <small>
                  {clock(s.start)} → {clock(s.end)}
                </small>
              </button>
            ))}
          </div>
          <div className="section-editor">
            <label>
              Source in
              <input
                aria-label="Section start"
                type="number"
                min={0}
                step=".1"
                value={+selectedSection.start.toFixed(2)}
                onChange={(e) =>
                  edit((p) => (p.segments[selected].start = +e.target.value))
                }
              />
            </label>
            <label>
              Source out
              <input
                aria-label="Section end"
                type="number"
                min={selectedSection.start + 0.08}
                step=".1"
                value={+selectedSection.end.toFixed(2)}
                onChange={(e) =>
                  edit((p) => (p.segments[selected].end = +e.target.value))
                }
              />
            </label>
            <button
              className="btn small"
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
              Remove
            </button>
          </div>
          <div className="section-editor">
            <label>
              Cut from
              <input
                aria-label="Cut start"
                type="number"
                min={0}
                step=".1"
                value={cutStart}
                onChange={(e) => setCutStart(+e.target.value)}
              />
            </label>
            <label>
              Cut to
              <input
                aria-label="Cut end"
                type="number"
                min={0}
                step=".1"
                value={cutEnd}
                onChange={(e) => setCutEnd(+e.target.value)}
              />
            </label>
            <button
              className="btn small"
              disabled={!!busy}
              onClick={() =>
                void action("Cutting", () =>
                  cut([
                    {
                      sourceId: selectedSection.sourceId,
                      start: cutStart,
                      end: cutEnd,
                    },
                  ]),
                )
              }
            >
              <Scissors size={14} />
              Cut this range
            </button>
            <button
              className="text-button small"
              onClick={() => {
                const point = (cutStart + cutEnd) / 2;
                if (
                  point > selectedSection.start &&
                  point < selectedSection.end
                )
                  edit((p) =>
                    p.segments.splice(
                      selected,
                      1,
                      { ...selectedSection, end: point },
                      { ...selectedSection, start: point },
                    ),
                  );
              }}
            >
              Split at midpoint
            </button>
          </div>
          <div className="add-section">
            <select
              aria-label="Add source recording"
              value={addId}
              onChange={(e) => setAddId(e.target.value)}
            >
              <option value="">Choose original source footage…</option>
              {videos.map((v) => (
                <option value={v.id} key={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              disabled={!addId}
              onClick={() => void action("Adding section", () => addSection())}
            >
              <Plus size={14} />
              Append
            </button>
            <button
              className="btn small"
              disabled={!addId}
              onClick={() =>
                void action("Replacing section", () => addSection(true))
              }
            >
              Replace selected
            </button>
          </div>
          <div className="actions studio-bottom-row">
            <a
              className="btn small"
              href={`/api/videos/${clip.id}/project.bundle`}
            >
              <Download size={14} />
              Export editable project
            </a>
            <button
              className="text-button small"
              disabled={!!busy}
              onClick={() =>
                void action("Finding cleanup suggestions", async () => {
                  const result = await api<typeof suggestions>(
                    `/api/videos/${sourceId}/suggestions`,
                    { method: "POST" },
                  );
                  setSuggestions(result);
                  setChosen([]);
                  if (!result.length)
                    notify("No silence or filler cuts were found.");
                })
              }
            >
              <Sparkles size={14} />
              Find silence & filler words
            </button>
          </div>
          {suggestions.length > 0 && (
            <div className="cleanup-list">
              <h3>Preview the suggested cuts.</h3>
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
                    {s.kind} {s.text || ""} · {clock(s.start)}–{clock(s.end)}
                  </span>
                  <button
                    className="text-button"
                    onClick={(e) => {
                      e.preventDefault();
                      onSeek(s.start);
                    }}
                  >
                    <Play size={12} />
                    Preview
                  </button>
                </label>
              ))}
              <button
                className="btn small"
                disabled={!chosen.length || !!busy}
                onClick={() =>
                  void action("Applying reviewed cuts", async () => {
                    await cut(chosen.map((i) => suggestions[i]));
                    setSuggestions([]);
                  })
                }
              >
                Apply {chosen.length} reviewed cuts
              </button>
            </div>
          )}
        </div>
      )}
      {tab === "transcript" && (
        <div className="studio-content">
          <div className="transcript-toolbar">
            <select
              aria-label="Transcript source"
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              {sourceIds.map((id) => (
                <option value={id} key={id}>
                  {videos.find((v) => v.id === id)?.title || clip.title}
                </option>
              ))}
            </select>
            <select
              aria-label="Local speech model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="Xenova/whisper-tiny.en">Fast · English</option>
              <option value="Xenova/whisper-tiny">Fast · Multilingual</option>
              <option value="Xenova/whisper-base.en">
                Higher quality · English
              </option>
            </select>
            <button
              className="btn small"
              disabled={!!busy}
              onClick={() =>
                void runJob(
                  "Transcribing locally",
                  `/api/videos/${sourceId}/transcribe`,
                  { model },
                ).then(() => transcript())
              }
            >
              <Sparkles size={14} />
              Transcribe locally
            </button>
          </div>
          <p className="studio-hint">
            The model downloads on first use. Audio is processed on this server;
            it is not uploaded to an AI provider.
          </p>
          <div className="transcript-toolbar">
            <input
              aria-label="Search transcript"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Find a word…"
            />
            <button
              className="btn small"
              onClick={() => importCaptions.current?.click()}
            >
              <Upload size={14} />
              Import SRT / VTT
            </button>
            <a
              className="btn small"
              href={`/api/videos/${clip.id}/captions.vtt`}
              download
            >
              VTT
            </a>
            <a
              className="btn small"
              href={`/api/videos/${clip.id}/captions.srt`}
              download
            >
              SRT
            </a>
          </div>
          <div className="transcript-words">
            {words.length ? (
              words.map((w, i) => (
                <button
                  key={i}
                  className={`${wordSelection.includes(i) ? "selected" : ""} ${search && w.text.toLowerCase().includes(search.toLowerCase()) ? "match" : ""}`}
                  title={`${w.start.toFixed(2)}–${w.end.toFixed(2)} seconds. Click to select; double-click to correct.`}
                  onClick={() => {
                    setWordSelection(
                      wordSelection.includes(i)
                        ? wordSelection.filter((n) => n !== i)
                        : [...wordSelection, i],
                    );
                    let t = 0;
                    for (const s of project.segments) {
                      if (
                        s.sourceId === sourceId &&
                        w.start >= s.start &&
                        w.start < s.end
                      ) {
                        onSeek(t + w.start - s.start);
                        break;
                      }
                      t += s.end - s.start;
                    }
                  }}
                  onDoubleClick={() => {
                    const corrected = prompt(
                      "Correct this transcript word or cue:",
                      w.text,
                    );
                    if (corrected !== null)
                      setWords(
                        words.map((word, n) =>
                          n === i ? { ...word, text: corrected } : word,
                        ),
                      );
                  }}
                >
                  {w.text}{" "}
                </button>
              ))
            ) : (
              <div className="transcript-empty">
                <FileText size={26} />
                <p>
                  Give your recording searchable words and accessible captions.
                </p>
              </div>
            )}
          </div>
          <div className="actions">
            <button
              className="btn small"
              disabled={!wordSelection.length || !!busy}
              onClick={() =>
                void action("Cutting selected words", async () => {
                  await cut(
                    wordSelection.map((i) => ({
                      sourceId,
                      start: words[i].start,
                      end: words[i].end,
                    })),
                  );
                  setWordSelection([]);
                })
              }
            >
              <Scissors size={14} />
              Cut {wordSelection.length} selected words from video
            </button>
            <button
              className="btn small"
              disabled={!words.length || !!busy}
              onClick={() =>
                void action("Saving corrections", async () => {
                  await api(`/api/videos/${sourceId}/transcript`, {
                    method: "PUT",
                    body: JSON.stringify({ words }),
                  });
                  notify("Transcript and captions updated");
                })
              }
            >
              <Check size={14} />
              Save transcript corrections
            </button>
          </div>
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
        <div className="studio-content">
          <div className="style-layout">
            <div>
              <div
                className="composition-preview"
                ref={preview}
                style={{
                  aspectRatio: `${project.layout.width}/${project.layout.height}`,
                  background: project.layout.background,
                }}
              >
                <video
                  src={`/api/videos/${project.segments[0].sourceId}/tracks/${state.sources.some((s) => s.role === "screen") ? "screen" : state.sources.some((s) => s.role === "primary") ? "primary" : "camera"}`}
                  muted
                  playsInline
                  preload="auto"
                  style={{
                    inset: `${(project.layout.padding / project.layout.width) * 100}%`,
                    width: `${100 - (project.layout.padding / project.layout.width) * 200}%`,
                    height: `${100 - (project.layout.padding / project.layout.height) * 200}%`,
                  }}
                />
                {state.sources.some((s) => s.role === "screen") &&
                  state.sources.some((s) => s.role === "camera") &&
                  project.layout.camera.visible && (
                    <video
                      className="composition-camera"
                      src={`/api/videos/${clip.id}/tracks/camera`}
                      muted
                      playsInline
                      preload="auto"
                      style={{
                        left: `${project.layout.camera.x * 100}%`,
                        top: `${project.layout.camera.y * 100}%`,
                        width: `${project.layout.camera.size * 100}%`,
                        height:
                          project.layout.camera.shape === "portrait"
                            ? `${((project.layout.camera.size * project.layout.width) / project.layout.height) * 135}%`
                            : `${((project.layout.camera.size * project.layout.width) / project.layout.height) * 100}%`,
                        borderRadius:
                          project.layout.camera.shape === "circle"
                            ? "50%"
                            : "8px",
                      }}
                    />
                  )}
              </div>
              <button
                className="text-button small"
                onClick={() =>
                  preview.current?.querySelectorAll("video").forEach((v) => {
                    if (v.paused) void v.play().catch(() => {});
                    else v.pause();
                  })
                }
              >
                <Play size={13} />
                Preview source layout
              </button>
            </div>
            <div className="style-controls">
              <label>
                Canvas
                <select
                  aria-label="Canvas preset"
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
                      Source · {project.layout.width} × {project.layout.height}
                    </option>
                  )}
                  <option value="1920x1080">Landscape · 1080p</option>
                  <option value="3840x2160">Landscape · 4K</option>
                  <option value="1080x1920">Portrait · 1080p</option>
                  <option value="1080x1080">Square · 1080p</option>
                </select>
              </label>
              <label>
                Background
                <input
                  aria-label="Background color"
                  type="color"
                  value={project.layout.background}
                  onChange={(e) =>
                    edit((p) => (p.layout.background = e.target.value))
                  }
                />
              </label>
              <label>
                Canvas padding
                <input
                  aria-label="Canvas padding"
                  type="range"
                  min={0}
                  max={Math.floor(
                    Math.min(project.layout.width, project.layout.height) / 3,
                  )}
                  step={2}
                  value={project.layout.padding}
                  onChange={(e) =>
                    edit((p) => (p.layout.padding = +e.target.value))
                  }
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={project.layout.camera.visible}
                  onChange={(e) =>
                    edit((p) => (p.layout.camera.visible = e.target.checked))
                  }
                />
                Show camera track
              </label>
              <label>
                Camera shape
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
              {(["x", "y", "size"] as const).map((key) => (
                <label key={key}>
                  Camera {key}
                  <input
                    aria-label={`Camera ${key}`}
                    type="range"
                    min={key === "size" ? 0.05 : 0}
                    max={key === "size" ? 0.6 : 0.95}
                    step=".01"
                    value={project.layout.camera[key]}
                    onChange={(e) =>
                      edit((p) => (p.layout.camera[key] = +e.target.value))
                    }
                  />
                </label>
              ))}
            </div>
          </div>
          <div className="audio-controls">
            <h3>
              <Volume2 size={16} />
              Sound
            </h3>
            {(["microphone", "system"] as const).map((key) => (
              <label key={key}>
                {key}
                <input
                  aria-label={`${key} volume`}
                  type="range"
                  min={0}
                  max={2}
                  step=".05"
                  value={project.layout.audio[key]}
                  onChange={(e) =>
                    edit((p) => (p.layout.audio[key] = +e.target.value))
                  }
                />
                <span>{Math.round(project.layout.audio[key] * 100)}%</span>
              </label>
            ))}
            <label className="check-label">
              <input
                type="checkbox"
                checked={project.layout.audio.normalize}
                onChange={(e) =>
                  edit((p) => (p.layout.audio.normalize = e.target.checked))
                }
              />
              Balance loudness
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={project.layout.audio.denoise}
                onChange={(e) =>
                  edit((p) => (p.layout.audio.denoise = e.target.checked))
                }
              />
              Reduce steady background noise
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={project.layout.captions}
                onChange={(e) =>
                  edit((p) => (p.layout.captions = e.target.checked))
                }
              />
              Burn captions into export
            </label>
          </div>
          <div className="section-heading studio-section-title">
            <h3>Focus, explain, or redact.</h3>
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
                Auto-zoom key moments
              </button>
            </div>
          </div>
          <div className="effect-add">
            {(["text", "arrow", "box", "blur", "zoom", "cursor"] as const).map(
              (type) => (
                <button
                  className="btn small"
                  key={type}
                  onClick={() =>
                    edit((p) =>
                      p.overlays.push({
                        id: freshId(),
                        type,
                        start: 0,
                        end: Math.min(3, total),
                        x: type === "zoom" ? 0.5 : 0.1,
                        y: type === "zoom" ? 0.5 : 0.15,
                        w: 0.3,
                        h: 0.15,
                        scale: 1.8,
                        text: type === "text" ? "A useful detail" : "",
                        color: "#d6f475",
                      }),
                    )
                  }
                >
                  <Plus size={12} />
                  {type}
                </button>
              ),
            )}
          </div>
          {project.overlays.map((o, i) => (
            <div className="effect-row" key={o.id}>
              <strong>
                {o.type}
                {o.auto && <small className="muted"> · auto</small>}
              </strong>
              {o.type === "text" && (
                <input
                  aria-label={`Effect text ${i + 1}`}
                  value={o.text}
                  maxLength={500}
                  onChange={(e) =>
                    edit((p) => (p.overlays[i].text = e.target.value))
                  }
                />
              )}
              <label>
                From
                <input
                  type="number"
                  min={0}
                  max={total}
                  step=".1"
                  value={o.start}
                  onChange={(e) =>
                    edit((p) => (p.overlays[i].start = +e.target.value))
                  }
                />
              </label>
              <label>
                To
                <input
                  type="number"
                  min={0}
                  max={total}
                  step=".1"
                  value={o.end}
                  onChange={(e) =>
                    edit((p) => (p.overlays[i].end = +e.target.value))
                  }
                />
              </label>
              {(["x", "y", "w", "h"] as const).map((key) => (
                <label key={key}>
                  {key} %
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
              {o.type === "zoom" && (
                <label>
                  Zoom
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
                aria-label={`Effect color ${i + 1}`}
                type="color"
                value={o.color}
                onChange={(e) =>
                  edit((p) => (p.overlays[i].color = e.target.value))
                }
              />
              <button
                className="icon-button danger"
                aria-label={`Remove effect ${i + 1}`}
                onClick={() => edit((p) => p.overlays.splice(i, 1))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <div className="cta-editor">
            <h3>A useful next step.</h3>
            <input
              aria-label="Call to action label"
              placeholder="Button label"
              value={project.cta.label}
              maxLength={80}
              onChange={(e) => edit((p) => (p.cta.label = e.target.value))}
            />
            <input
              aria-label="Call to action URL"
              type="url"
              placeholder="https://…"
              value={project.cta.url}
              onChange={(e) => edit((p) => (p.cta.url = e.target.value))}
            />
          </div>
        </div>
      )}
      {tab === "ai" && (
        <div className="studio-content">
          <div className="transcript-toolbar">
            <select
              aria-label="AI provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="local">Local AI · on this server</option>
              <option value="ollama">Configured Ollama server</option>
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
              Summarize & make chapters
            </button>
          </div>
          {provider !== "local" ? (
            <label className="check-label">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              Send this transcript to the configured AI server
            </label>
          ) : (
            <p className="studio-hint">
              The local summarization model downloads once. Recorded audio and
              text stay on this server.
            </p>
          )}
          {outline.summary && (
            <div className="generated-outline">
              <h3>Summary</h3>
              <textarea
                className="outline-summary"
                aria-label="Video summary"
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
              <button
                className="btn small"
                disabled={!!busy}
                onClick={() =>
                  void action("Saving summary", async () => {
                    onRendered(
                      await api<Clip>(`/api/videos/${clip.id}/outline`, {
                        method: "PUT",
                        body: JSON.stringify(outline),
                      }),
                    );
                    notify("Summary corrected and saved");
                  })
                }
              >
                <Check size={14} />
                Save summary
              </button>
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
                  <h3>Recorded action items</h3>
                  <ul>
                    {outline.actionItems.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          <div className="studio-section-title">
            <h3>Turn a walkthrough into useful context.</h3>
            <p className="studio-hint">
              Drafts use your recorded context. Review generated text and
              placeholders before sending.
            </p>
          </div>
          <div className="transcript-toolbar">
            <select
              aria-label="Context format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="agent">Agent prompt</option>
              <option value="bug">Bug report</option>
              <option value="sop">Step-by-step procedure</option>
              <option value="pr">PR description</option>
              <option value="message">Message / email</option>
            </select>
            <button
              className="btn small"
              onClick={() =>
                void action("Preparing context", async () =>
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
                aria-label="Generated context draft"
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
              <button
                className="btn small"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(context)
                    .then(() => notify("Context copied"))
                }
              >
                Copy draft
              </button>
            </>
          )}
        </div>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {busy && (
        <div className="studio-job" role="status">
          <LoaderCircle size={16} className="spin" />
          {busy}
          {job && (
            <>
              <progress max={100} value={job.progress} />
              <span>{Math.round(job.progress)}%</span>
            </>
          )}
        </div>
      )}
      <div className="studio-save-bar">
        <span className="small muted">
          {dirty ? "Unsaved project changes" : "Project saved"} · Watch page:
          revision {clip.revision || 0}
        </span>
        <div className="actions">
          <button
            className="btn small"
            disabled={!dirty || !!busy}
            onClick={() =>
              void action("Saving project", async () => {
                await persist();
              })
            }
          >
            <Check size={14} />
            Save project
          </button>
          <button
            className="btn small"
            disabled={!!busy}
            onClick={() =>
              void action("Exporting edited copy", async () => {
                await persist();
                const j = await api<Job>(`/api/videos/${clip.id}/render`, {
                  method: "POST",
                  body: JSON.stringify({ copy: true }),
                });
                await awaitJob(j, setJob);
                notify("Edited copy saved");
                dispatchEvent(new CustomEvent("relay:library"));
              })
            }
          >
            Export copy
          </button>
          <button
            className="btn primary small"
            disabled={!!busy}
            onClick={() =>
              void action("Rendering and publishing", async () => {
                await persist();
                const j = await api<Job>(`/api/videos/${clip.id}/render`, {
                  method: "POST",
                  body: JSON.stringify({}),
                });
                await awaitJob(j, setJob);
                onRendered(await api<Clip>(`/api/videos/${clip.id}`));
                notify(
                  "Published. Your existing share link now plays this revision.",
                );
              })
            }
          >
            <Send size={14} />
            Render & publish
          </button>
        </div>
      </div>
    </section>
  );
}
