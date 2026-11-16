// The one FFmpeg build Relay uses on each Mac chip, shared by the app
// (desktop/engine.cjs) and `npm run desktop:provision`. `sha256` is the archive as
// published; `binarySha256` is the `ffmpeg` file extracted from it.
module.exports = {
  "darwin-arm64": {
    version: "9.0.2",
    url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
    sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
    binarySha256:
      "2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384",
  },
  "darwin-x64": {
    version: "9.0.2",
    url: "https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip",
    sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
    binarySha256:
      "b25689cf2211c0582d317e849912769a1f1c93904fe102c485b5364a425633d1",
  },
};
