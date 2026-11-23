// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { App } from "../../App.jsx";
import { ApiError, api } from "../../lib/api.js";
import { SessionProvider } from "../auth/session.jsx";

vi.mock("../../lib/api.js", async (original) => ({
  ...(await original()),
  api: vi.fn(),
}));

const published = {
  id: "matinee",
  title: "Matinee",
  status: "on_sale",
  startsAt: "2026-11-24T18:00:00Z",
  timeZone: "UTC",
  totalSeats: 40,
};
const evening = {
  ...published,
  id: "evening",
  title: "Evening",
  status: "scheduled",
};
const draft = {
  ...published,
  id: "draft",
  title: "Draft screening",
  status: "draft",
  type: "bus",
  venue: "Screen One",
  description: "Upcoming screening",
  currency: "INR",
  saleStartsAt: "2026-11-23T18:00:00Z",
  tierPrices: { standard: 19999 },
  revision: 0,
};
const checkedAt = "2026-11-23T09:00:00Z";
const snapshot = {
  event: published,
  metrics: {
    queueLength: 7,
    activeAdmissions: 2,
    activeHolds: 1,
    availableSeats: 29,
    soldSeats: 8,
    reclaimableSeats: 0,
  },
  admissions: [{ start: checkedAt, count: 2 }],
  asOf: checkedAt,
};

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.resetAllMocks();
});

function show(path, { role = "organizer", integrity } = {}) {
  const user = { id: "owner", role, isGuest: false };
  window.sessionStorage.setItem(
    "queuetix.session",
    JSON.stringify({
      token: "fixture",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  api.mockImplementation(async (route) => {
    if (route === "/me") return { user };
    if (route === "/organizer/events?page=1")
      return { events: [published, draft, evening], hasNext: false };
    if (route === "/organizer/events/matinee") return { event: published };
    if (route === "/organizer/events/draft") return { event: draft };
    if (route === "/operations/events/matinee") return snapshot;
    if (route === "/operations/events/evening")
      return {
        ...snapshot,
        event: evening,
        metrics: {
          ...snapshot.metrics,
          queueLength: 0,
          availableSeats: null,
          soldSeats: null,
        },
      };
    if (route === "/operations/events/matinee/integrity" && integrity)
      return integrity();
    throw new Error("Unexpected test route " + route);
  });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <App />
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("each published organizer row links to Operations and the owner can navigate back to the editor", async () => {
  show("/organizer/events");
  const matinee = await screen.findByRole("link", {
    name: "View Operations for Matinee",
  });
  expect(matinee.getAttribute("href")).toBe("/operations/events/matinee");
  expect(
    screen
      .getByRole("link", { name: "View Operations for Evening" })
      .getAttribute("href"),
  ).toBe("/operations/events/evening");
  const draftLink = screen.getByRole("link", { name: draft.title });
  expect(
    within(draftLink.closest("li")).queryByRole("link", {
      name: /View Operations/,
    }),
  ).toBeNull();

  fireEvent.click(matinee);
  const manage = await screen.findByRole("link", { name: "Manage Event" });
  expect(manage.getAttribute("href")).toBe("/organizer/events/matinee");
  expect(
    screen.getByRole("heading", { name: "Admissions per minute" }),
  ).toBeTruthy();
  fireEvent.click(manage);
  const back = await screen.findByRole("link", {
    name: "View Operations",
    exact: true,
  });
  expect(back.getAttribute("href")).toBe("/operations/events/matinee");
  expect(
    screen
      .getByRole("link", { name: "View public event" })
      .getAttribute("href"),
  ).toBe("/events/matinee");
});

test("the organizer overview fetches only the selected published snapshot and preserves zero and unavailable counts", async () => {
  show("/organizer/events");
  const summary = await screen.findByRole("region", {
    name: "Operations summary",
  });
  expect(await within(summary).findByText("29", { exact: true })).toBeTruthy();
  expect(within(summary).getByText("7", { exact: true })).toBeTruthy();
  expect(summary.querySelector("time").dateTime).toBe(checkedAt);
  expect(
    api.mock.calls
      .filter(([route]) => route.startsWith("/operations/"))
      .map(([route]) => route),
  ).toEqual(["/operations/events/matinee"]);

  fireEvent.change(within(summary).getByLabelText("Published event"), {
    target: { value: evening.id },
  });
  expect(
    await within(summary).findAllByText("Unavailable", { exact: true }),
  ).toHaveLength(2);
  expect(
    within(summary).getByText("People in queue").nextElementSibling.textContent,
  ).toBe("0");
  expect(
    within(summary).queryByRole("heading", { name: "Admissions per minute" }),
  ).toBeNull();
  expect(
    within(summary).queryByRole("button", { name: "Run integrity check" }),
  ).toBeNull();
});

test("a draft editor has no Operations shortcut", async () => {
  show("/organizer/events/draft");
  await screen.findByRole("heading", { name: draft.title });
  expect(screen.queryByRole("link", { name: "View Operations" })).toBeNull();
  expect(screen.getByRole("button", { name: "Publish event" })).toBeTruthy();
});

test("admins retain Operations access without receiving an organizer edit shortcut", async () => {
  show("/operations/events/matinee", { role: "admin" });
  await screen.findByRole("heading", { name: published.title });
  expect(
    screen.getByRole("link", { name: "All operations events" }),
  ).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Manage Event" })).toBeNull();
  expect(
    screen.getByRole("button", { name: "Run integrity check" }),
  ).toBeTruthy();
});

test("a failed integrity request demotes the prior PASS to history and a completed retry replaces it", async () => {
  const later = "2026-11-23T09:05:00Z";
  const integrity = vi
    .fn()
    .mockResolvedValueOnce({
      status: "PASS",
      checkedAt,
      issues: [],
      issueCount: 0,
    })
    .mockRejectedValueOnce(
      new ApiError("The database is temporarily unavailable.", 503),
    )
    .mockResolvedValueOnce({
      status: "FAIL",
      checkedAt: later,
      issues: ["Seat counts differ."],
      issueCount: 1,
    });
  show("/operations/events/matinee", { integrity });
  const check = await screen.findByRole("region", {
    name: "Inventory integrity",
  });
  const run = within(check).getByRole("button", {
    name: "Run integrity check",
  });
  fireEvent.click(run);
  await within(check).findByText("PASS", { exact: true });
  expect(within(check).getByRole("status").textContent).toContain("PASS");

  fireEvent.click(run);
  expect(
    await within(check).findByText("Latest check could not complete."),
  ).toBeTruthy();
  expect(within(check).getByRole("alert").textContent).toContain(
    "The database is temporarily unavailable.",
  );
  expect(within(check).queryByRole("status")).toBeNull();
  const history = within(check).getByText(/Last completed check/);
  expect(history.textContent).toContain("PASS");
  expect(history.querySelector("time").dateTime).toBe(checkedAt);

  fireEvent.click(run);
  expect(await within(check).findByText("Seat counts differ.")).toBeTruthy();
  expect(within(check).getByRole("status").textContent).toContain("FAIL");
  expect(within(check).getByRole("status").querySelector("time").dateTime).toBe(
    later,
  );
  expect(within(check).queryByRole("alert")).toBeNull();
  expect(within(check).queryByText(/Last completed check/)).toBeNull();
});
