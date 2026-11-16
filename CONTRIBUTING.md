# Contributing to Relay

Thanks for helping make Relay better. Bug reports, ideas and pull requests are all welcome.

## Getting set up

```sh
git clone https://github.com/saassteve/relay-studio.git
cd relay-studio
npm ci
npm run dev        # web app at http://127.0.0.1:5173
npm run desktop    # the Mac app, from source
```

Node 24.15 or later is required. On Apple Silicon, `npm run desktop:provision` fetches the same verified FFmpeg the Mac app uses. On Linux, install your distribution's `ffmpeg` and set `FFMPEG_BIN`.

## Before you open a pull request

```sh
npm run build          # type-check and build
npm test               # API and render tests
npm run test:e2e       # Chrome end-to-end tests
npm run test:desktop   # Electron smoke test (macOS)
```

- Keep changes focused. One feature or fix per pull request is easiest to review.
- Add or update a test for behaviour you change.
- Match the existing style; `npm run format` runs Prettier.
- UI copy is short, plain and friendly. Say what happens, not how clever it is.

## Where to start

The "Not yet" rows in the [comparison table](README.md#how-relay-compares) are the most wanted features. Issues labelled `good first issue` are a gentle way in.

## Privacy is a feature

Relay records people's screens, cameras and voices. Changes must keep data on the user's machine or server by default, never add telemetry, and ask before sending anything to a third party.
