import { jest } from "@jest/globals";
import { startQueueJobs } from "../src/modules/queue/jobs.js";

test("scheduler and expiry never overlap and resume after a socket timeout", async () => {
  jest.useFakeTimers();
  const timeout = new Error("Timed out during socket read (2499ms)");
  let failTick, finishSweep;
  const tick = jest.fn().mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        failTick = reject;
      }),
  );
  const sweep = jest.fn(
    () =>
      new Promise((resolve) => {
        finishSweep = resolve;
      }),
  );
  const report = jest.fn();
  const stop = startQueueJobs({ tick, sweep }, report);
  try {
    await jest.advanceTimersByTimeAsync(6000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(sweep).not.toHaveBeenCalled();
    failTick(timeout);
    await jest.advanceTimersByTimeAsync(1000);
    expect(report).toHaveBeenCalledWith(
      timeout,
      expect.objectContaining({ phase: "queue tick" }),
    );
    expect(sweep).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    finishSweep();
    await jest.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(3);
    stop();
    await jest.advanceTimersByTimeAsync(6000);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(sweep).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    jest.useRealTimers();
  }
});
