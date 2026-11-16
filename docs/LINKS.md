# Links that work for anyone

The Relay app keeps your videos on your own computer. That is what makes it private, and it is also why a link from the app only opens on that computer. To give someone a link they can open anywhere, the finished video has to live on a server that is always on.

Relay does that with one setting. Connect a Relay server you run, and **Send** in the editor gives you a link instead of a file.

## How it works

1. Set up a Relay server with the [self-hosting guide](SELF-HOSTING.md). Docker or Node, about ten minutes.
2. On the server, open **Settings → Links that work anywhere** and copy the address and access key.
3. In the Relay app, open the same place in Settings, paste them in and choose **Connect**.
4. Open a video, choose **Send**, then **Get a link**.

Relay sends the finished video, its title and its transcript to your server and gives you a link. When you edit the video later, **Update link** replaces it on the server, so the same link plays the new version. **Take link down** removes it from the server.

Only finished videos are sent, and only when you ask. Your original recordings and your edits stay on your computer.

## Good to know

- Videos sent to a server can be up to 1 GB.
- Passwords, expiry dates and invite-only access for a link are set on the server, in that video's Share settings.
- The access key can add and edit videos on the server, so treat it like a password. Disconnecting in the app does not remove links you already made.
- Both sides need Relay 0.7 or later.
