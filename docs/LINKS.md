# Share a video

You can send a video file or create a link to a copy stored in an online Relay workspace. Recording and editing happen on your computer. You choose when a finished video is uploaded.

## Send a video file

1. Open the video and choose **Send**.
2. Choose **Download video**.
3. Send the file using a service you trust.

The recipient receives a copy they can keep.

## Create a link

An online workspace is a Relay website that stores the videos you choose to share. Your team or a trusted administrator runs it.

1. Ask your workspace owner for its **workspace address** and **connection key**. Treat the key like a password.
2. In the Mac app, open **Settings → Online sharing**, paste those two items and choose **Connect**.
3. Open your video and choose **Send**.
4. Choose **Who can watch**. New links start with **Workspace members**, so viewers sign in with their workspace account. To share outside your workspace, choose **People with the link and password** or **Anyone with the link**, if your workspace permits it.
5. Review the expiry and download options. New links expire in seven days and hide the download button by default. You can change both choices before uploading.
6. Review your video and transcript for private information, then choose **Create share link**.
7. Copy the link and send it. If you chose a password, use at least 12 characters and send it separately.

Relay shows the workspace receiving the upload. The workspace receives the finished video, title, description, transcript and preview. Its administrator can access uploaded videos, so use a workspace you trust. HTTPS protects the connection during transfer.

Viewers need to be able to open the workspace address in their browser. Closing the Mac app or putting your Mac to sleep leaves the online copy available while the workspace is running and the link is valid. An address containing **localhost** or **127.0.0.1** refers to the computer opening it.

## Understand access

- **Workspace members** requires a signed-in account in that Relay workspace.
- **People with the link and password** requires the video password. Send that password separately.
- **Anyone with the link** also includes people who receive a forwarded link.
- **Link expires** controls when the link stops opening.
- **Show a download button** controls the download option in the player. Viewers can make their own copies, including screen recordings.

After sharing, the app checks who can watch. **Manage access in workspace** opens the place where you can change passwords, expiry or invited members. Updating the shared video preserves its access settings.

## Update or stop sharing

**Update shared video** replaces the online video and keeps the same link. **Stop sharing** removes the online copy and stops that link from opening. People who already saved a copy can keep it.

Disconnecting a workspace leaves already shared copies online. The app keeps showing those copies and their workspace address. Reconnect to that workspace to update or stop sharing them.

Deleting a video from your Mac can also leave its online copy available. Use **Stop sharing** first if you want to remove that copy too, or manage it in the online workspace.

If an upload loses its connection, Relay keeps track of its destination and shows **Upload needs checking**. Use **Check upload** to verify the result, or **Stop sharing** to remove a possible copy. Uploading again uses the same video identity.

## Need a workspace?

Ask your team or someone you trust to set up and maintain Relay online. They manage access, hosting and backups. Relay software is free, and hosting may have a cost. You can send downloaded video files while online sharing is disconnected.

The [setup guide for workspace administrators](SELF-HOSTING.md) covers hosting. Both the app and workspace need Relay 0.7.2 or later for the new privacy controls.

## For workspace owners

Open **Settings → Online sharing** on your HTTPS workspace and give approved people its address and a connection key. New connection keys allow publishing and removing shared copies. API and MCP access use a separate integration key.

Use **Reset connection key** if a sharing key is exposed or a device should lose access. Apps using that key need the new one for uploading and removing copies. Existing review links keep their own access settings.

Older connections may use a key with full workspace access. The Mac app identifies those connections so you can replace the key with a sharing-only connection key.
