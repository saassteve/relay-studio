// A steady timer that keeps firing when the page is in a background tab, where
// browsers slow ordinary timers to about once a second. Recording pipelines use
// it so captured frames don't stutter when you switch to the window you're sharing.
export function ticker(fn: () => void, fps: number): () => void {
  const interval = 1000 / fps;
  try {
    const source = `let t=setInterval(()=>postMessage(0),${interval});onmessage=()=>clearInterval(t)`;
    const url = URL.createObjectURL(
      new Blob([source], { type: "text/javascript" }),
    );
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    let busy = false;
    worker.onmessage = () => {
      // Skip a beat rather than queue up if a frame is still being drawn.
      if (busy) return;
      busy = true;
      try {
        fn();
      } finally {
        busy = false;
      }
    };
    return () => {
      worker.postMessage(0);
      worker.terminate();
    };
  } catch {
    const timer = setInterval(fn, interval);
    return () => clearInterval(timer);
  }
}
