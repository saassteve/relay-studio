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
| `ADMIN_PASSWORD`, `ADMIN_EMAIL` | Workspace owner sign-in. |
| `PUBLIC_URL` | The exact HTTPS origin people use. Put Relay behind an HTTPS reverse proxy. |
| `DATA_DIR` | Where the library, media and models are stored. Back it up with the server stopped. |
| `FFMPEG_BIN` | Path to the FFmpeg executable. |
| `OLLAMA_URL`, `OLLAMA_MODEL` | Optional summaries through your own Ollama server. Relay asks before sending a transcript. |

Limits: imports 1 GB, project bundles 2 GB expanded, recording sessions 8 GB.

## Connect the Mac app to your server

```sh
RELAY_SERVER_URL=https://relay.example.com /Applications/Relay.app/Contents/MacOS/Relay
```

The app then records into the server's library and its share links work everywhere.

## Team features

- Owner, editor and viewer roles. Invitations create expiring links you send yourself.
- Per-video access: anyone with the link, workspace members, or invited people only. Plus passwords, expiry and download control.
- Comments with replies, resolve, reactions and `@mentions`, with in-app notifications.

## Local AI

Transcription uses Whisper and summaries use DistilBART, both through Transformers.js on the server's CPU. Models download on first use into `DATA_DIR/models` and then work offline. English tiny/base and multilingual tiny Whisper models are available. AI output is editable and can be wrong.

## Integrations

Workspace settings shows a bearer token for the read-only API and an MCP endpoint at `/mcp` with `search_videos`, `get_video_context` and `create_context_draft`, so AI agents can use your recordings as context. A configured webhook can be triggered per video. Relay never posts anywhere automatically.

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
