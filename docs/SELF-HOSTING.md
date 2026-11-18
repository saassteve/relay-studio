# Self-hosting and configuration

Run Relay on a server so share links work for anyone, invite your team, and keep every recording on infrastructure you control.

## Docker

```sh
cp .env.example .env   # set ADMIN_PASSWORD, ADMIN_EMAIL and PUBLIC_URL
docker compose up --build -d
```

The image runs as a non-root user, stores everything in a persistent volume and includes a full FFmpeg build.

## Node

```sh
cp .env.example .env
npm ci && npm run build
npm start
```

On Linux, install your distribution's `ffmpeg` and set `FFMPEG_BIN=/usr/bin/ffmpeg`. The `ffmpeg-static` fallback lacks the subtitle and text filters used by caption and overlay renders.

## Settings

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Listen address. Any non-local `HOST` requires `ADMIN_PASSWORD` (12+ characters). |
| `ADMIN_PASSWORD`, `ADMIN_EMAIL` | Workspace owner sign-in. The password is the owner's first one; a new value here replaces whatever the owner has since chosen. |
| `PUBLIC_URL` | The exact HTTPS origin people use. Put Relay behind an HTTPS reverse proxy. Link previews in chat apps use this address too. |
| `TRUST_PROXY` | Set this behind a reverse proxy so Relay sees each visitor's own address (it limits repeated attempts per address). Use the number of proxies in front of Relay, usually `1`, or a comma-separated list of their addresses or subnets such as `10.0.0.0/8`. `true` trusts every proxy, so only use it when Relay can't be reached directly. Leave it unset when there is no proxy. |
| `DATA_DIR` | Where the library, media and models are stored. Back it up with the server stopped. |
| `FFMPEG_BIN` | Path to the FFmpeg executable. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Optional summaries through your own Ollama server. Relay asks before sending a transcript. |
| `RELAY_WEBHOOK_URL`, `RELAY_WEBHOOK_SECRET` | Optional address that receives a video's details when someone sends it from Relay, and the bearer secret sent with it. |

With Docker, `compose.yaml` passes `ADMIN_PASSWORD`, `ADMIN_EMAIL`, `PUBLIC_URL`, `TRUST_PROXY` and the Ollama and webhook settings from `.env` to the container. The image sets the rest.

Limits: imports 1 GB, project bundles 2 GB expanded, recording sessions 8 GB.

## Send videos from the Mac app to your server

Keep recording and editing on your Mac, and send only finished videos to the server for a link anyone can open. On the server, open **Settings → Online sharing** and copy the workspace address and connection key. In the app, paste them into Settings → Online sharing. Use the sharing-only connection key for devices. The integration key grants broader API and MCP access. See [Links that work for anyone](LINKS.md).

## Run the Mac app against your server

```sh
RELAY_SERVER_URL=https://relay.example.com /Applications/Relay.app/Contents/MacOS/Relay
```

The app then records into the server's library and its share links work everywhere.

## Team features

- Owner, editor and viewer roles. Invitations create expiring links you send yourself.
- Passwords: everyone changes their own in **Settings**. For a member who has forgotten theirs, the owner makes a reset link from the members list (the key button) and sends it to them; it works once and lasts 24 hours. `ADMIN_PASSWORD` is the owner's first password, and the way back in if the owner forgets theirs: set a new value and restart Relay. Restarting with the same value leaves a password the owner has since chosen alone.
- Invitation and reset links are shown once, when they are made. Relay keeps only a hash of each, so a lost link is replaced with a new one.
- Per-video access: anyone with the link, workspace members, or invited people only. Plus passwords, expiry and download control.
- Comments with replies, resolve, reactions and `@mentions`, with in-app notifications.

## Local AI

Transcription uses Whisper and summaries use DistilBART, both through Transformers.js on the server's CPU. Models download on first use into `DATA_DIR/models` and then work offline. English tiny/base and multilingual tiny Whisper models are available. AI output is editable and can be wrong.

## Bring your own AI

An owner can connect one AI provider in **Settings → AI assistant**: Google Gemini, Groq or OpenRouter (free tiers), Claude, ChatGPT, or an Ollama server you run. Relay uses it to draft titles, descriptions, chapters and title cards, and to turn a video into a document.

- The key is stored in the workspace database in `DATA_DIR` and is not sent back to the browser (only its last four characters are shown), so protect that folder and its backups.
- A transcript goes to a hosted provider only when someone asks for a draft and confirms it. Ollama requests stay on your network.
- No provider is contacted until one is connected.

## Integrations

Settings shows a bearer token for the API and an MCP endpoint at `/mcp`. Assistants such as Claude and ChatGPT can use it to:

- find and read your recordings: `search_videos`, `get_video_context`, `create_context_draft`
- edit them: `get_project`, `edit_video` (cut, remove fillers and pauses, add titles and zooms, change layout, look and captions), `render_video` and `get_render_status`

Edits made this way are saved as a draft you can undo; nothing is published until `render_video` is called. Treat the token like a password. A configured webhook can be triggered per video. Relay never posts anywhere automatically.

## Portability

Export any video as a `.relay` bundle containing original tracks, edits, transcript and layout, with integrity checks. Import it into any other Relay.

## Development

```sh
npm run dev            # web app with hot reload
npm run desktop        # Mac app from source
npm test               # API tests
npm run test:e2e       # Chrome end-to-end tests
npm run test:desktop   # Electron smoke test
npm run desktop:dist   # build the DMG and ZIP into release/
node scripts/screenshots.mjs   # regenerate README images
```
