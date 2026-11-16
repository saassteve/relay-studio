import { pipeline, env } from "@huggingface/transformers";
import { readFileSync, mkdirSync } from "node:fs";
const [input, cache, model = "Xenova/whisper-tiny.en", task = "transcribe"] =
  process.argv.slice(2);
mkdirSync(cache, { recursive: true });
env.cacheDir = cache;
const progress_callback = (p) => {
  if (p.status === "progress")
    process.stderr.write(`RELAY_PROGRESS:${Math.round(p.progress || 0)}\n`);
};
if (task === "prepare") {
  // Download and load the model once so the first transcription can run offline.
  await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    device: "cpu",
    progress_callback,
  });
  process.stdout.write(JSON.stringify({ ready: true, model }));
} else if (task === "summarize") {
  const summarizer = await pipeline(
    "summarization",
    "Xenova/distilbart-cnn-6-6",
    {
      dtype: "q8",
      device: "cpu",
      progress_callback,
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    },
  );
  const text = readFileSync(input, "utf8");
  const result = await summarizer(text.slice(0, 16000), {
    max_new_tokens: 160,
    min_new_tokens: 25,
  });
  process.stdout.write(
    JSON.stringify({ summary: result[0]?.summary_text || "" }),
  );
} else {
  const transcriber = await pipeline("automatic-speech-recognition", model, {
    dtype: "q8",
    device: "cpu",
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    progress_callback,
  });
  const buffer = readFileSync(input);
  const audio = new Float32Array(
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  );
  const result = await transcriber(audio, {
    return_timestamps: "word",
    chunk_length_s: 30,
    stride_length_s: 5,
  });
  process.stdout.write(JSON.stringify(result));
}
