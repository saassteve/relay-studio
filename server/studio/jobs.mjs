import { randomUUID } from "node:crypto";
import { parseJSON, problem, publicError } from "./schema.mjs";
export function createJobs(db) {
  const handlers = new Map();
  const working = new Set();
  let closed = false;
  const publicJob = (row) =>
    row && { ...row, payload: undefined, result: parseJSON(row.result, null) };
  const get = (id) => {
    const row = db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!row) throw problem(404, "That job was not found.");
    return publicJob(row);
  };
  const drain = async (lane) => {
    if (working.has(lane) || closed) return;
    working.add(lane);
    try {
      while (!closed) {
        const row = db
          .prepare(
            `SELECT * FROM jobs WHERE status='queued' AND type ${lane === "ai" ? "IN" : "NOT IN"} ('transcribe','summarize','prepare-ai') ORDER BY CASE type WHEN 'finish-recording' THEN 0 WHEN 'render' THEN 1 ELSE 2 END,created LIMIT 1`,
          )
          .get();
        if (!row) break;
        if (!handlers.has(row.type)) {
          // A job from another version would otherwise block its whole lane.
          db.prepare(
            "UPDATE jobs SET status='failed',error=?,updated=? WHERE id=?",
          ).run(
            "This job type isn't supported by this version of Relay.",
            new Date().toISOString(),
            row.id,
          );
          continue;
        }
        db.prepare("UPDATE jobs SET status='running',updated=? WHERE id=?").run(
          new Date().toISOString(),
          row.id,
        );
        try {
          const progress = (n) => {
            if (!closed)
              db.prepare("UPDATE jobs SET progress=?,updated=? WHERE id=?").run(
                Math.max(0, Math.min(99, n)),
                new Date().toISOString(),
                row.id,
              );
          };
          const result = await handlers.get(row.type)(
            parseJSON(row.payload, {}),
            progress,
            row.id,
          );
          if (!closed)
            db.prepare(
              "UPDATE jobs SET status='complete',progress=100,result=?,updated=? WHERE id=?",
            ).run(JSON.stringify(result), new Date().toISOString(), row.id);
        } catch (e) {
          if (!closed) {
            if (row.type === "finish-recording")
              db.prepare(
                "UPDATE recordings SET status='interrupted' WHERE id=? AND status='processing'",
              ).run(parseJSON(row.payload, {}).recordingId);
            console.error(`Job ${row.type}:`, e.message);
            db.prepare(
              "UPDATE jobs SET status='failed',error=?,updated=? WHERE id=?",
            ).run(publicError(e), new Date().toISOString(), row.id);
          }
        }
      }
    } finally {
      working.delete(lane);
    }
  };
  const wake = () => {
    void drain("media");
    void drain("ai");
  };
  return {
    get,
    register(type, handler) {
      handlers.set(type, handler);
      queueMicrotask(wake);
    },
    enqueue(type, payload) {
      const id = randomUUID(),
        time = new Date().toISOString();
      db.prepare(
        "INSERT INTO jobs(id,type,payload,status,created,updated) VALUES(?,?,?,?,?,?)",
      ).run(id, type, JSON.stringify(payload), "queued", time, time);
      queueMicrotask(wake);
      return get(id);
    },
    retry(id) {
      const j = get(id);
      if (j.status !== "failed")
        throw problem(409, "Only failed jobs can be retried.");
      if (j.type === "finish-recording") {
        const row = db.prepare("SELECT payload FROM jobs WHERE id=?").get(id);
        db.prepare("UPDATE recordings SET status='processing' WHERE id=?").run(
          parseJSON(row.payload, {}).recordingId,
        );
      }
      db.prepare(
        "UPDATE jobs SET status='queued',error=NULL,progress=0 WHERE id=?",
      ).run(id);
      queueMicrotask(wake);
      return get(id);
    },
    close() {
      closed = true;
    },
    list() {
      return db
        .prepare("SELECT * FROM jobs ORDER BY created DESC LIMIT 50")
        .all()
        .map(publicJob);
    },
  };
}
