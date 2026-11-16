import express from "express";
import path from "node:path";
import { createApp } from "./app.mjs";
const { app, close } = createApp({
  dataDir: process.env.RELAY_DATA_DIR,
  password: "",
});
app.use(express.static(path.resolve("dist")));
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
    process.on("SIGTERM", () =>
      server.close(() => {
        close();
        process.exit(0);
      }),
    );
  });
  server.once("error", (error) => {
    if (port && error.code === "EADDRINUSE") listen(0);
    else throw error;
  });
}
listen(preferred);
