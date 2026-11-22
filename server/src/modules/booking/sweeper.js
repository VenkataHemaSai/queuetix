export function startExpirySweeper(sweepExpired, onFailure) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepExpired();
    } catch (error) {
      onFailure(error);
    } finally {
      running = false;
    }
  }, 5000).unref();
}
