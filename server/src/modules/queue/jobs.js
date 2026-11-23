export function startQueueJobs(runtime, reportFailure) {
  let running = false;
  let stopped = false;
  let nextSweep = performance.now() + 5000;

  async function run(phase, work) {
    const started = performance.now();
    try {
      await work();
    } catch (error) {
      reportFailure(error, {
        phase,
        elapsedMs: Math.round(performance.now() - started),
      });
    }
  }

  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      if (performance.now() >= nextSweep) {
        nextSweep = performance.now() + 5000;
        await run("expiry sweep", runtime.sweep);
      }
      if (!stopped) await run("queue tick", () => runtime.tick(reportFailure));
    } finally {
      running = false;
    }
  }, 1000).unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
