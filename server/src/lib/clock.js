export const systemClock = { now: () => new Date() };

export function createFakeClock(initialTime) {
  let time = new Date(initialTime).getTime();
  return {
    now: () => new Date(time),
    advance(milliseconds) {
      time += milliseconds;
    },
  };
}
