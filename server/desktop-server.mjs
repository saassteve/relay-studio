import express from "express";
import path from "node:path";
import { createApp } from "./app.mjs";
import { stopChildren } from "./children.mjs";

const { app, close } = createApp({
  dataDir: process.env.RELAY_DATA_DIR,
  password: "",
  localSecret: process.env.RELAY_LOCAL_SECRET || "",
});
// If Relay itself is force-quit, don't linger holding the port and the library.
const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) {
    stopChildren();
    process.exit(0);
  }
}, 2000).unref();
app.use(express.static(path.resolve("dist")));
// A missing build file must not be answered with the app's page: a browser
// would cache that HTML as a script.
app.use("/assets", (req, res) => res.status(404).end());
app.get("/{*path}", (req, res) =>
  res.sendFile("index.html", { root: path.resolve("dist") }),
);
// A stable port keeps local share links valid across app restarts.
// If it is taken (for example by a second copy), fall back to any free port.
const preferred = Number(process.env.RELAY_PORT) || 0;
function listen(port) {
  const server = app.listen(port, "127.0.0.1");
  server.once("listening", () => {
    console.log(`RELAY_READY:http://127.0.0.1:${server.address().port}`);
    process.on("SIGTERM", () => {
      stopChildren();
      server.close(() => {
        close();
        process.exit(0);
      });
    });
  });
  server.once("error", (error) => {
    if (port && error.code === "EADDRINUSE") listen(0);
    else throw error;
  });
}
listen(preferred);
