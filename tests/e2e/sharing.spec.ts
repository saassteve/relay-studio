import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createApp } from "../../server/app.mjs";

test("connect a workspace, choose protected sharing, disconnect, reconnect and stop sharing", async ({
  page,
  browser,
}) => {
  page.setDefaultTimeout(20_000);
  const directory = await mkdtemp(path.join(os.tmpdir(), "relay-sharing-ui-"));
  const receiver = createApp({
    dataDir: directory,
    password: "workspace-owner-password",
    shell: () => html,
  });
  // The preview shell is synchronous, like the production server.
  const html = await readFile("dist/index.html", "utf8");
  const server = receiver.app;
  server.use(express.static(path.resolve("dist")));
  server.get("/{*path}", (_req, res) => res.type("html").send(html));
  const listener = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => listener.once("listening", resolve));
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Workspace did not start");
  const base = "http://127.0.0.1:" + address.port;
  const guest = await browser.newContext();
  try {
    const login = await fetch(base + "/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "workspace-owner-password" }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const key = (
      await (
        await fetch(base + "/api/cloud/key", { headers: { Cookie: cookie } })
      ).json()
    ).key;
    await page.request.delete("/api/cloud");
    await page.request.put("/api/preferences", { data: { onboarded: true } });
    const uploaded = await page.request.post("/api/videos", {
      multipart: {
        title: "A private walkthrough",
        duration: "7",
        video: {
          name: "presenter.mp4",
          mimeType: "video/mp4",
          buffer: await readFile("scripts/assets/presenter.mp4"),
        },
      },
    });
    expect(uploaded.ok()).toBeTruthy();
    const video = await uploaded.json();
    await page.goto("/video/" + video.id);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const send = page.getByRole("dialog", { name: "Send this video" });
    await expect(
      send.getByRole("link", { name: "Download video" }),
    ).toBeVisible();
    await send.getByRole("button", { name: "Set up online sharing" }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.getByLabel("Workspace address", { exact: true }).fill(base);
    await settings.getByLabel("Connection key", { exact: true }).fill(key);
    await settings
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await expect(
      settings.getByText("Connected to " + new URL(base).host, { exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByLabel("Connection key", { exact: true }),
    ).toHaveCount(0);
    await settings.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      send.getByRole("combobox", { name: "Who can watch", exact: true }),
    ).toHaveValue("workspace");
    await expect(
      send.getByRole("combobox", { name: "Link expires", exact: true }),
    ).toHaveValue("7");
    await expect(send.getByLabel("Show a download button")).not.toBeChecked();
    await expect(
      send.getByText(/administrator can access uploaded videos/),
    ).toBeVisible();
    await expect(
      send.getByText(/address points to this computer/),
    ).toBeVisible();
    expect(
      receiver.db.prepare("SELECT count(*) AS n FROM videos").get().n,
    ).toBe(0);

    await send
      .getByRole("combobox", { name: "Who can watch", exact: true })
      .selectOption("password");
    const create = send.getByRole("button", {
      name: "Create share link",
      exact: true,
    });
    await expect(create).toBeDisabled();
    await send
      .getByLabel("Video password", { exact: true })
      .fill("shared-separately");
    await page.screenshot({
      path: "test-results/sharing-before-upload.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => send.evaluate((el) => el.scrollWidth <= el.clientWidth))
      .toBe(true);
    await expect
      .poll(() =>
        send
          .locator(".dialog-body")
          .evaluate((el) => el.scrollHeight > el.clientHeight),
      )
      .toBe(true);
    await page.screenshot({
      path: "test-results/sharing-mobile.png",
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await create.click();
    const link = send.getByRole("textbox", { name: "Shared video link" });
    await expect(link).toBeVisible();
    const url = await link.inputValue();
    await expect(
      send.getByText("Viewers need the link and password", { exact: true }),
    ).toBeVisible();

    const watch = await guest.newPage();
    await watch.goto(url);
    await expect(
      watch.getByRole("heading", { name: "This video is password-protected" }),
    ).toBeVisible();
    await expect(
      watch.getByRole("heading", {
        name: "A private walkthrough",
        exact: true,
      }),
    ).toHaveCount(0);
    const token = url.split("/s/")[1];
    expect(
      (
        await guest.request.get(base + "/api/share/" + token + "/media")
      ).status(),
    ).toBe(401);
    await watch
      .getByRole("textbox", { name: "Watch password" })
      .fill("shared-separately");
    await watch
      .getByRole("button", { name: "Watch video", exact: true })
      .click();
    await expect(
      watch.getByRole("heading", {
        name: "A private walkthrough",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      (
        await guest.request.get(
          base + "/api/share/" + token + "/media?download=1",
        )
      ).status(),
    ).toBe(403);

    // Disconnecting leaves the published copy visible and usable.
    await page.request.delete("/api/cloud");
    await send.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      send.getByRole("textbox", { name: "Shared video link" }),
    ).toHaveValue(url);
    await expect(
      send.getByRole("button", { name: "Connect original workspace" }),
    ).toBeVisible();
    await expect(
      send.getByRole("button", { name: "Stop sharing", exact: true }),
    ).toBeDisabled();
    await page.screenshot({
      path: "test-results/sharing-disconnected-copy.png",
      animations: "disabled",
    });

    await page.request.put("/api/cloud", { data: { url: base, key } });
    await send.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      send.getByRole("button", { name: "Stop sharing", exact: true }),
    ).toBeEnabled();
    await send
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(
      "People who already saved a copy can keep it",
    );
    await confirm
      .getByRole("button", { name: "Stop sharing", exact: true })
      .click();
    await expect(
      send.getByRole("textbox", { name: "Shared video link" }),
    ).toHaveCount(0);
    expect(
      (await guest.request.get(base + "/api/share/" + token)).status(),
    ).toBe(404);
    expect((await page.request.get("/api/videos/" + video.id)).status()).toBe(
      200,
    );
  } finally {
    await guest.close();
    await page.request.delete("/api/cloud");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    receiver.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("copying a link waits for privacy changes and blocks copying when saving fails", async ({
  page,
  browser,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.request.delete("/api/cloud");
  await page.request.put("/api/preferences", { data: { onboarded: true } });
  const uploaded = await page.request.post("/api/videos", {
    multipart: {
      title: "Access must save first",
      duration: "7",
      video: {
        name: "presenter.mp4",
        mimeType: "video/mp4",
        buffer: await readFile("scripts/assets/presenter.mp4"),
      },
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const video = await uploaded.json();
  const guest = await browser.newContext();
  let releaseSave = () => {};
  try {
    await page.goto("/video/" + video.id);
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const send = page.getByRole("dialog", { name: "Send this video" });
    await send
      .getByText("Share page on this computer", { exact: true })
      .click();
    const link = send.getByRole("textbox", { name: "Share link", exact: true });
    await expect(link).not.toHaveValue("");
    const localUrl = await link.inputValue();
    const token = localUrl.split("/s/")[1];
    const access = send.getByRole("group", { name: "Sharing access settings" });
    await access
      .getByLabel("Video password", { exact: true })
      .fill("first-private-password");
    await expect(link).toBeDisabled();
    await expect(link).toHaveValue("");
    await page.evaluate(() =>
      navigator.clipboard.writeText("privacy-sentinel"),
    );
    let saveRequests = 0;
    let saveStarted = () => {};
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const endpoint = "**/api/videos/" + video.id + "/share-settings";
    await page.route(endpoint, async (route) => {
      saveRequests += 1;
      saveStarted();
      await gate;
      await route.continue();
    });
    await send
      .getByRole("button", { name: "Save access and copy link", exact: true })
      .click();
    await started;
    await expect(access).toHaveAttribute("aria-busy", "true");
    await expect(
      access.getByRole("button", { name: "Embed", exact: true }),
    ).toBeDisabled();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "privacy-sentinel",
    );
    releaseSave();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(localUrl);
    expect(saveRequests).toBe(1);
    expect((await guest.request.get("/api/share/" + token)).status()).toBe(401);
    await page.unroute(endpoint);

    await access
      .getByLabel("Replace video password", { exact: true })
      .fill("second-private-password");
    await access.getByRole("button", { name: "Embed", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("/embed/" + token);
    expect(
      await page.evaluate(() => navigator.clipboard.readText()),
    ).not.toContain("second-private-password");
    expect(
      (
        await guest.request.post("/api/share/" + token + "/unlock", {
          data: { password: "first-private-password" },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await guest.request.post("/api/share/" + token + "/unlock", {
          data: { password: "second-private-password" },
        })
      ).status(),
    ).toBe(200);

    await access
      .getByLabel("Replace video password", { exact: true })
      .fill("third-private-password");
    await page.evaluate(() =>
      navigator.clipboard.writeText("failed-save-sentinel"),
    );
    await page.route(endpoint, (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Access settings could not be saved" }),
      }),
    );
    await access
      .getByRole("button", { name: "Link to 0:00", exact: true })
      .click();
    await expect(access.getByRole("alert")).toHaveText(
      "Access settings could not be saved",
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "failed-save-sentinel",
    );
    await send
      .getByRole("button", { name: "Save access and copy link", exact: true })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "failed-save-sentinel",
    );
    await send
      .getByRole("button", { name: "Save and close", exact: true })
      .click();
    await expect(send).toBeVisible();
    await expect(link).toBeDisabled();
    await page.unroute(endpoint);
    await send
      .getByRole("button", { name: "Save and close", exact: true })
      .click();
    await expect(send).toBeHidden();
  } finally {
    releaseSave();
    await guest.close();
    await page.request.delete("/api/videos/" + video.id);
  }
});
