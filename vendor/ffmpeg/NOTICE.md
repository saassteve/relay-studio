# Video engine (FFmpeg)

Relay's source is MIT licensed and its download contains no FFmpeg binary. Relay runs FFmpeg as a separate program.

**Mac app.** On first launch, Relay downloads Martin Riedl's FFmpeg 9.0.2 GPLv3+ build for the Mac's chip directly from the publisher into `~/Library/Application Support/Relay/engine/`. It checks the archive's SHA-256 when it downloads it, and at every launch rejects any build that reports nonfree components.

- Binary archive (Apple Silicon): https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
- Archive SHA-256: `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924`
- Binary archive (Intel): https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip
- Archive SHA-256: `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4`
- Configuration and library versions: https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt
- Build scripts: https://git.martin-riedl.de/ffmpeg/build-script
- FFmpeg source: https://git.ffmpeg.org/ffmpeg.git (tag `n9.0.2`)

**From source.** `npm run desktop:provision` places the same verified build in `vendor/ffmpeg/darwin-arm64/` for development. On Linux, install your distribution's `ffmpeg` and set `FFMPEG_BIN`. Set `FFMPEG_BIN` to use any FFmpeg you prefer.

The packaging step refuses to build an app that bundles an FFmpeg binary.
