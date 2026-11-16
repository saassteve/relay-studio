# Links that work for anyone

The Relay app keeps your videos on your own computer. That is what makes it private, and it is also why a link from the app only opens on that computer. To give someone a link they can open anywhere, the finished video has to live on a server that is always on.

Relay does that with one setting. Connect a Relay server, and **Send** in the editor gives you a link instead of a file.

## How it works

1. In the Relay app, open **Settings → Links that work anywhere**.
2. Enter the server's address and its access key, then choose **Connect**.
3. Open a video, choose **Send**, then **Get a link**.

Relay sends the finished video, its title and its transcript to the server and gives you a link. When you edit the video later, **Update link** replaces it on the server, so the same link plays the new version. **Take link down** removes it from the server.

Only finished videos are sent, and only when you ask. Your original recordings and your edits stay on your computer.

## Where the server comes from

| | Host it yourself | Relay Cloud |
| --- | --- | --- |
| Who runs it | You | [brep](https://brep.ai/?ref=relay-cloud), the team behind Relay |
| Cost | Free, on your own server | Paid |
| Setup | [Self-hosting guide](SELF-HOSTING.md): Docker or Node, about ten minutes | We set it up and send you an address and an access key |

### Host it yourself

Follow the [self-hosting guide](SELF-HOSTING.md). On your server, open **Settings → Links that work anywhere** and copy the address and access key into the app.

### Relay Cloud

Relay Cloud is a Relay server run for you, for people who want share links without looking after a server. It is a paid service from brep.

To ask about it, [get in touch through brep.ai](https://brep.ai/?ref=relay-cloud).

## Good to know

- Videos sent to a server can be up to 1 GB.
- Passwords, expiry dates and invite-only access for a link are set on the server, in that video's Share settings.
- The access key can add and edit videos on the server, so treat it like a password. Disconnecting in the app does not remove links you already made.
- Both sides need Relay 0.7 or later.
