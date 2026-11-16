import archiver from "archiver";
import yauzl from "yauzl";
import multer from "multer";
import { randomUUID, createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { getProject, validateProject } from "./project.mjs";
import { parseJSON, problem, safeMime } from "./schema.mjs";
const hashFile = async (file) => {
  const hash = createHash("sha256");
  for await (const data of createReadStream(file)) hash.update(data);
  return hash.digest("hex");
};
export function registerPortable({
  app,
  db,
  dataDir,
  owner,
  find,
  serialize,
  renderer,
  sourceFind,
}) {
  app.get("/api/videos/:id/project.bundle", owner, async (req, res, next) => {
    try {
      const v = find(req.params.id),
        project = getProject(v),
        ids = [...new Set([v.id, ...project.segments.map((s) => s.sourceId)])],
        sources = [];
      const files = [];
      for (const id of ids) {
        const source = sourceFind(id),
          assets = [];
        for (const asset of renderer.assetsFor(source)) {
          const file = path.join(dataDir, "media", asset.filename),
            name = `assets/${id}_${asset.role}${path.extname(asset.filename)}`;
          assets.push({
            role: asset.role,
            name,
            mime: asset.mime,
            duration: asset.duration,
            info: parseJSON(asset.info, {}),
            sha256: await hashFile(file),
            size: statSync(file).size,
          });
          files.push({ file, name });
        }
        sources.push({
          id,
          title: source.title,
          description: source.description,
          duration: source.duration,
          thumbnail: source.thumbnail,
          transcript: parseJSON(source.transcript, []),
          outline: parseJSON(source.outline, {}),
          assets,
        });
      }
      res.attachment(`relay-${v.id}.relay`);
      res.type("application/zip");
      const archive = archiver("zip", { zlib: { level: 0 } });
      archive.on("error", next);
      res.on("close", () => archive.abort());
      archive.pipe(res);
      archive.append(
        JSON.stringify(
          {
            format: "relay-project",
            version: 1,
            mainId: v.id,
            title: v.title,
            project,
            sources,
          },
          null,
          2,
        ),
        { name: "relay-project.json" },
      );
      for (const file of files) archive.file(file.file, { name: file.name });
      await archive.finalize();
    } catch (e) {
      next(e);
    }
  });
  const upload = multer({
    dest: path.join(dataDir, "tmp"),
    limits: { fileSize: 2 * 1024 ** 3, files: 1 },
  });
  app.post(
    "/api/projects/import",
    owner,
    upload.single("project"),
    async (req, res, next) => {
      const dir = mkdtempSync(path.join(dataDir, "tmp", "import-"));
      const moved = [];
      try {
        if (!req.file) throw problem(400, "Choose a .relay project bundle.");
        const entries = await unzip(req.file.path, dir);
        if (!entries.has("relay-project.json"))
          throw problem(400, "This archive is not a Relay project.");
        const manifest = JSON.parse(
          readFileSync(path.join(dir, "relay-project.json"), "utf8"),
        );
        if (
          manifest.format !== "relay-project" ||
          manifest.version !== 1 ||
          !Array.isArray(manifest.sources) ||
          manifest.sources.length > 100 ||
          !manifest.sources.length
        )
          throw problem(400, "Unsupported project bundle.");
        const ids = new Map(manifest.sources.map((s) => [s.id, randomUUID()])),
          records = [];
        for (const source of manifest.sources) {
          if (
            !Array.isArray(source.assets) ||
            !source.assets.length ||
            source.assets.length > 5
          )
            throw problem(400, "The bundle has invalid source tracks.");
          const id = ids.get(source.id),
            assets = [];
          for (const asset of source.assets) {
            if (
              !/^assets\/[a-f0-9-]{36}_(screen|camera|microphone|system|primary)\.(mp4|webm|m4a)$/.test(
                asset.name,
              ) ||
              !entries.has(asset.name)
            )
              throw problem(400, "An expected source track is missing.");
            if (
              !["screen", "camera", "microphone", "system", "primary"].includes(
                asset.role,
              ) ||
              !Number.isFinite(asset.duration) ||
              asset.duration <= 0 ||
              asset.duration > 86400
            )
              throw problem(400, "Invalid track metadata.");
            const file = path.join(dir, asset.name);
            if (
              (await hashFile(file)) !== asset.sha256 ||
              statSync(file).size !== asset.size
            )
              throw problem(400, "A source track failed its integrity check.");
            // Only WebM or MP4 containers are handed to the media engine.
            const head = Buffer.alloc(12),
              fd = openSync(file, "r");
            try {
              readSync(fd, head, 0, 12, 0);
            } finally {
              closeSync(fd);
            }
            if (
              !head
                .subarray(0, 4)
                .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
              head.subarray(4, 8).toString() !== "ftyp"
            )
              throw problem(415, "A bundled source is not readable media.");
            const info = await import("./render.mjs").then((m) =>
              m.probe(file),
            );
            if (!info.hasAudio && !info.hasVideo)
              throw problem(415, "A bundled source is not readable media.");
            const filename = `${id}-${asset.role}${path.extname(asset.name)}`;
            renameSync(file, path.join(dataDir, "media", filename));
            moved.push(filename);
            assets.push({ ...asset, filename, info });
          }
          const primary =
            assets.find((a) => a.role === "screen") ||
            assets.find((a) => a.role === "primary") ||
            assets.find((a) => a.role === "camera");
          if (!primary)
            throw problem(400, "A bundled video source is missing.");
          records.push({ source, id, assets, primary });
        }
        db.exec("BEGIN IMMEDIATE");
        let main;
        try {
          for (const row of records) {
            const s = row.source;
            db.prepare(
              "INSERT INTO videos(id,title,description,duration,size,mime,filename,thumbnail,created,transcript,outline) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ).run(
              row.id,
              String(s.title || "Imported source").slice(0, 160),
              String(s.description || "").slice(0, 20000),
              row.primary.duration,
              row.primary.size,
              safeMime(row.primary.mime),
              row.primary.filename,
              typeof s.thumbnail === "string" &&
                s.thumbnail.startsWith("data:image/jpeg;base64,") &&
                s.thumbnail.length < 1200000
                ? s.thumbnail
                : null,
              new Date().toISOString(),
              JSON.stringify(
                (Array.isArray(s.transcript) ? s.transcript : [])
                  .slice(0, 100000)
                  .map((w) => ({
                    text: String(w?.text ?? "").slice(0, 2000),
                    start: Number(w?.start),
                    end: Number(w?.end),
                    granularity:
                      w?.granularity === "segment" ? "segment" : "word",
                  }))
                  .filter(
                    (w) =>
                      Number.isFinite(w.start) &&
                      Number.isFinite(w.end) &&
                      w.start >= 0 &&
                      w.end > w.start,
                  ),
              ),
              JSON.stringify(s.outline || {}),
            );
            for (const a of row.assets)
              db.prepare("INSERT INTO assets VALUES(?,?,?,?,?,?)").run(
                row.id,
                a.role,
                a.filename,
                safeMime(a.mime),
                a.duration,
                JSON.stringify(a.info),
              );
          }
          main = ids.get(manifest.mainId);
          if (!main)
            throw problem(400, "The main project source was not found.");
          const project = validateProject(
            {
              ...manifest.project,
              segments: manifest.project.segments.map((s) => ({
                ...s,
                sourceId: ids.get(s.sourceId),
              })),
            },
            sourceFind,
          );
          db.prepare("UPDATE videos SET project=? WHERE id=?").run(
            JSON.stringify(project),
            main,
          );
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        res.status(201).json(serialize(find(main)));
      } catch (e) {
        for (const file of moved)
          rmSync(path.join(dataDir, "media", file), { force: true });
        next(
          e.status
            ? e
            : problem(400, "This project bundle could not be imported."),
        );
      } finally {
        if (req.file) rmSync(req.file.path, { force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}
async function unzip(file, directory) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true }, (e, z) =>
      e ? reject(e) : resolve(z),
    ),
  );
  const entries = new Set();
  let total = 0;
  return await new Promise((resolve, reject) => {
    const fail = (e) => {
      zip.close();
      reject(e);
    };
    zip.on("error", fail);
    zip.on("end", () => resolve(entries));
    zip.on("entry", (entry) => {
      (async () => {
        const name = entry.fileName;
        if (
          !/^(relay-project\.json|assets\/[a-f0-9-]{36}_(screen|camera|microphone|system|primary)\.(mp4|webm|m4a))$/.test(
            name,
          ) ||
          entries.has(name) ||
          ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
        )
          throw problem(
            400,
            "The bundle contains an unexpected archive entry.",
          );
        total += entry.uncompressedSize;
        if (
          total > 2 * 1024 ** 3 ||
          entry.uncompressedSize > 1024 ** 3 ||
          entries.size > 600
        )
          throw problem(413, "The expanded project exceeds its size limit.");
        if (
          name === "relay-project.json" &&
          entry.uncompressedSize > 10 * 1024 * 1024
        )
          throw problem(413, "The project manifest is too large.");
        const dest = path.join(directory, name);
        if (name.startsWith("assets/"))
          (await import("node:fs")).mkdirSync(path.dirname(dest), {
            recursive: true,
          });
        const input = await new Promise((resolve, reject) =>
          zip.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s))),
        );
        let size = 0;
        input.on("data", (d) => {
          size += d.length;
          if (size > entry.uncompressedSize || size > 1024 ** 3)
            input.destroy(
              problem(413, "The archive expanded beyond its declared size."),
            );
        });
        await pipeline(input, createWriteStream(dest));
        entries.add(name);
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}
