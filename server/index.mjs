import express from "express";
import path from "node:path";
import { createApp } from "./app.mjs";
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
const { app, close } = createApp({
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : undefined,
});
let vite;
if (
  process.env.NODE_ENV === "production" ||
  process.argv.includes("--production")
) {
  app.use(express.static(path.resolve("dist")));
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
  server.close(async () => {
    await vite?.close();
    close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
