# Video engine (FFmpeg)

Relay's source is MIT licensed and its download contains no FFmpeg binary. Relay runs FFmpeg as a separate program.

**Mac app.** On first launch, Relay downloads Martin Riedl's FFmpeg 9.0.2 GPLv3+ build for the Mac's chip directly from the publisher into `~/Library/Application Support/Relay/engine/`. It checks the archive's SHA-256 when it downloads it. At every launch, before running the engine, it checks the SHA-256 of the `ffmpeg` binary itself and rejects any build that reports nonfree components; a binary that does not match is deleted and downloaded again.

- Binary archive (Apple Silicon): https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
- Archive SHA-256: `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924`
- `ffmpeg` binary SHA-256: `2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384`
- Binary archive (Intel): https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip
- Archive SHA-256: `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4`
- `ffmpeg` binary SHA-256: `b25689cf2211c0582d317e849912769a1f1c93904fe102c485b5364a425633d1`
- Configuration and library versions: https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt
- Build scripts: https://git.martin-riedl.de/ffmpeg/build-script
- FFmpeg source: https://git.ffmpeg.org/ffmpeg.git (tag `n9.0.2`)

**From source.** `npm run desktop:provision` places the same verified build in `vendor/ffmpeg/darwin-arm64/` for development. On Linux, install your distribution's `ffmpeg` and set `FFMPEG_BIN`. Set `FFMPEG_BIN` to use any FFmpeg you prefer.

The packaging step refuses to build an app that bundles an FFmpeg binary.
