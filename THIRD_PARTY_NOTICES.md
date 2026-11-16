# Third-party software

Relay's original source is MIT licensed. Dependencies retain their own licenses; the lockfile records exact versions.

- React, Vite, Express, Multer, Lucide, Electron and Playwright: see their installed package license files.
- DM Sans and Manrope: SIL Open Font License 1.1. Fonts are served locally. Their complete notices are in `public/fonts/DM-Sans-OFL.txt` and `public/fonts/Manrope-OFL.txt`.
- **FFmpeg** is not included in Relay's download. On first launch the Mac app fetches a pinned GPLv3+ build of FFmpeg 9.0.2 directly from its publisher and checks its SHA-256 before use. It runs as a separate program. Build provenance and source links are in `vendor/ffmpeg/NOTICE.md`; FFmpeg licensing: https://ffmpeg.org/legal.html. `ffmpeg-static` is only a convenience for running from source.
- Transformers.js (Apache-2.0) and ONNX Runtime (MIT) run local inference. The tested [Xenova/whisper-tiny.en](https://huggingface.co/Xenova/whisper-tiny.en) and [Xenova/distilbart-cnn-6-6](https://huggingface.co/Xenova/distilbart-cnn-6-6) ONNX model repositories declare Apache-2.0. Upstream OpenAI Whisper is MIT licensed. Consult each model card for additional variants. Model weights download on first use and are not part of this source repository.
- Archiver, yauzl, Hls.js and electron-updater retain their installed package licences.
