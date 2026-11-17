import express from "express";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.mjs";
import { stopChildren } from "./children.mjs";

const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 5173);
if (
  !["127.0.0.1", "localhost", "::1"].includes(host) &&
  (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12)
) {
  throw new Error(
    "Set ADMIN_PASSWORD to at least 12 characters before listening on a public interface.",
  );
}
const production =
  process.env.NODE_ENV === "production" ||
  process.argv.includes("--production");
// The development server hands out any file in the project folder, the library
// included, so it never listens beyond this computer.
if (!production && !["127.0.0.1", "localhost", "::1"].includes(host))
  throw new Error(
    "Development mode only runs on this computer. To listen on another HOST, run `npm run build` and then `npm start`.",
  );
let vite;
const { app, close } = createApp({
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : undefined,
  // Shared links answer with this page plus their preview tags. In development
  // Vite has to prepare it first, as it does for every other address.
  shell: async (req) =>
    production
      ? readFile(path.resolve("dist", "index.html"), "utf8")
      : vite.transformIndexHtml(
          req.originalUrl,
          await readFile(path.resolve("index.html"), "utf8"),
        ),
});
if (production) {
  app.use(express.static(path.resolve("dist")));
  // A missing build file must not be answered with the app's page: a browser
  // would cache that HTML as a script.
  app.use("/assets", (req, res) => res.status(404).end());
  app.get("/{*path}", (req, res) =>
    res.sendFile("index.html", { root: path.resolve("dist") }),
  );
} else {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
const server = app.listen(port, host, () =>
  console.log(`Relay is ready at http://${host}:${port}`),
);
async function shutdown() {
  stopChildren();
  server.close(async () => {
    await vite?.close();
    close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
