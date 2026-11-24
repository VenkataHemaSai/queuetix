// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { Simulation } from "./Simulation.jsx";
afterEach(cleanup);
function show(request) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Simulation userId="admin" request={request} />
    </QueryClientProvider>,
  );
}
test("an empty demo shows no invented result and posts numeric limits", async () => {
  let run = null;
  const request = vi.fn(async (_, opts) => {
    if (opts.method === "POST") {
      run = {
        runId: "one",
        state: "running",
        cleanup: "pending",
        progress: { phase: "Joining lobby", joined: 2 },
        config: { users: 12 },
      };
      return run;
    }
    return { run };
  });
  show(request);
  await screen.findByText("No simulation has run yet.");
  expect(screen.queryByText("Integrity passed")).toBeNull();
  fireEvent.change(screen.getByLabelText("Bot count"), {
    target: { value: "12" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Run demo simulation" }));
  await screen.findByText(/Joining lobby/);
  expect(request).toHaveBeenCalledWith("/operations/simulation", {
    method: "POST",
    body: { users: 12, seats: 40 },
  });
  expect(
    screen.getByRole("button", { name: "Run demo simulation" }).disabled,
  ).toBe(true);
});
test("a status failure offers a retry and keeps start disabled", async () => {
  show(vi.fn().mockRejectedValue(new Error("Simulation storage unavailable.")));
  await screen.findByRole("alert");
  expect(
    screen.getByRole("button", { name: "Run demo simulation" }).disabled,
  ).toBe(true);
  expect(screen.queryByText("No simulation has run yet.")).toBeNull();
});
test("a failed run retains its actual configuration and cleanup outcome", async () => {
  show(
    vi.fn().mockResolvedValue({
      run: {
        state: "failed",
        cleanup: "complete",
        startedAt: "2026-11-24T10:00:00Z",
        config: { users: 7, seats: 4 },
        message: "The worker stopped before finishing.",
      },
    }),
  );
  await screen.findByText("The worker stopped before finishing.");
  expect(screen.getByRole("status").textContent).toContain(
    "Run failed. Cleanup complete.",
  );
  expect(screen.getByText(/7 bots · 4 seats/)).toBeTruthy();
  expect(screen.queryByText("Integrity passed")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Run demo simulation" }).disabled,
  ).toBe(false);
});
