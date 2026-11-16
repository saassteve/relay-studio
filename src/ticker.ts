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
    // Ticks arrive on the main thread's queue. If drawing a frame takes longer
    // than the interval (a slow machine, or software rendering), skip ticks so
    // the page always gets at least as much time as the frames do.
    let next = 0;
    worker.onmessage = () => {
      const started = performance.now();
      if (started < next) return;
      fn();
      const ended = performance.now();
      next = ended + Math.min(250, ended - started);
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
