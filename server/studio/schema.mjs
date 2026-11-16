export function migrateStudio(db) {
  const add = (table, name, declaration) => {
    if (
      !db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((c) => c.name === name)
    )
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  };
  for (const [name, type] of Object.entries({
    project: "TEXT NOT NULL DEFAULT '{}'",
    published_project: "TEXT NOT NULL DEFAULT '{}'",
    transcript: "TEXT NOT NULL DEFAULT '[]'",
    outline: "TEXT NOT NULL DEFAULT '{}'",
    share_config: "TEXT NOT NULL DEFAULT '{}'",
    revision: "INTEGER NOT NULL DEFAULT 0",
    history_cursor: "INTEGER NOT NULL DEFAULT 0",
  }))
    add("videos", name, type);
  for (const [name, type] of Object.entries({
    parent_id: "TEXT",
    resolved: "INTEGER NOT NULL DEFAULT 0",
    mentions: "TEXT NOT NULL DEFAULT '[]'",
    member_id: "TEXT",
  }))
    add("comments", name, type);
  db.exec(`CREATE TABLE IF NOT EXISTS assets(video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,role TEXT NOT NULL,filename TEXT NOT NULL,mime TEXT NOT NULL,duration REAL NOT NULL,info TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(video_id,role));
    CREATE TABLE IF NOT EXISTS recordings(id TEXT PRIMARY KEY,title TEXT NOT NULL,created TEXT NOT NULL,status TEXT NOT NULL,meta TEXT NOT NULL,duration REAL NOT NULL DEFAULT 0,video_id TEXT,job_id TEXT);
    CREATE TABLE IF NOT EXISTS recording_parts(recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,role TEXT NOT NULL,seq INTEGER NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(recording_id,role,seq));
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,progress REAL NOT NULL DEFAULT 0,result TEXT,error TEXT,created TEXT NOT NULL,updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_history(video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,cursor INTEGER NOT NULL,project TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(video_id,cursor));
    CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,revision INTEGER NOT NULL,filename TEXT NOT NULL,project TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS viewer_sessions(video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,session_id TEXT NOT NULL,intervals TEXT NOT NULL DEFAULT '[]',qualified INTEGER NOT NULL DEFAULT 0,plays INTEGER NOT NULL DEFAULT 0,cta INTEGER NOT NULL DEFAULT 0,member_id TEXT,created TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(video_id,session_id));
    CREATE TABLE IF NOT EXISTS viewer_grants(id TEXT PRIMARY KEY,token TEXT NOT NULL,version INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,video_id TEXT REFERENCES videos(id) ON DELETE CASCADE,kind TEXT NOT NULL,message TEXT NOT NULL,member_id TEXT,seen INTEGER NOT NULL DEFAULT 0,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_sessions(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS invitations(token TEXT PRIMARY KEY,email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,expires INTEGER NOT NULL,accepted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  db.prepare(
    "UPDATE jobs SET status='queued',progress=0 WHERE status='running'",
  ).run();
  db.prepare(
    "UPDATE recordings SET status='interrupted' WHERE status='recording'",
  ).run();
}
export const parseJSON = (value, fallback) => {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
};
export const problem = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

// Media is only ever served with a known audio/video type, whatever was stored.
const MEDIA_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "audio/webm",
  "audio/mp4",
]);
export function safeMime(value) {
  const base = String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return MEDIA_TYPES.has(base) ? base : "application/octet-stream";
}
export function mediaHeaders(res, mime) {
  res.set({
    "Content-Type": safeMime(mime),
    "Content-Security-Policy": "sandbox",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
  });
}
// Keeps job errors useful without exposing command lines or server paths.
export function publicError(error) {
  const text = String(error?.message || error || "This job failed.");
  if (!/Command failed:/.test(text)) return text.slice(0, 500);
  const detail = text
    .split("\n")
    .slice(1)
    .map((l) => l.replace(/(?:\/[^\s'":]+)+/g, "…").trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ");
  return `The media engine couldn't process this${detail ? `: ${detail}` : "."}`.slice(
    0,
    500,
  );
}
