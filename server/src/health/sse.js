export function streamHealth(response, clock) {
  response.status(200).set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  response.flushHeaders();

  function send(event, payload) {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    response.flush?.();
  }

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const time = clock.now().toISOString();
    send("tick", { tick, time });
    if (tick === 10) {
      clearInterval(timer);
      send("done", { time });
      response.end();
    }
  }, 2000);
  response.once("close", () => clearInterval(timer));
}
