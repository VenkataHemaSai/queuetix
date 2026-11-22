// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { buildLayout } from "../../../shared/seat-layout.js";
import { EventDetail, Events } from "./events/EventPages.jsx";
import { SeatMap } from "./events/SeatMap.jsx";
import { OrganizerEvent } from "./events/OrganizerPages.jsx";
import { Account, Login, OrganizerOnly } from "./auth/AuthPages.jsx";
import { SessionProvider } from "./auth/session.jsx";
import { api, ApiError } from "../lib/api.js";

vi.mock("../lib/api.js", async (original) => ({
  ...(await original()),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.resetAllMocks();
});

function show(element, path = "/") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>{element}</SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("event discovery distinguishes loading, retryable failures and a genuine empty list", async () => {
  api.mockRejectedValueOnce(
    new ApiError("The service is temporarily unavailable.", 503),
  );
  api.mockResolvedValueOnce({ events: [], page: 1, hasNext: false });
  show(<Events />);
  expect(screen.getByRole("status").textContent).toMatch(/Loading/);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("heading", { name: "No published events" });
});

test("demo sign-in stores a session and the account shows an expired session when revalidation fails", async () => {
  api.mockImplementation(async (path) => {
    if (path === "/auth/demo")
      return {
        user: {
          id: "guest",
          role: "attendee",
          isGuest: true,
          name: "Demo guest",
        },
        token: "test-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    return {
      user: {
        id: "guest",
        role: "attendee",
        isGuest: true,
        name: "Demo guest",
      },
    };
  });
  const view = show(<Login />);
  fireEvent.click(
    screen.getByRole("button", { name: "Continue as a demo guest" }),
  );
  await waitFor(() =>
    expect(window.sessionStorage.getItem("queuetix.session")).toContain(
      "test-token",
    ),
  );
  expect(api).toHaveBeenCalledWith(
    "/auth/demo",
    expect.objectContaining({ method: "POST" }),
  );
  view.unmount();
  api.mockRejectedValue(
    new ApiError("Your session expired.", 401, "SESSION_EXPIRED"),
  );
  show(<Account />);
  await screen.findByText("Your session expired. Sign in again.");
});

test("attendees see an access denial on organizer routes", async () => {
  window.sessionStorage.setItem(
    "queuetix.session",
    JSON.stringify({
      token: "guest",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  api.mockResolvedValue({
    user: { id: "guest", role: "attendee", isGuest: true, name: "Demo guest" },
  });
  show(
    <OrganizerOnly>
      <h1>Organizer editor</h1>
    </OrganizerOnly>,
  );
  await screen.findByRole("heading", { name: "Organizer access required" });
  expect(
    screen.queryByRole("heading", { name: "Organizer editor" }),
  ).toBeNull();
});

test("published seat map has labels and a text alternative without booking controls", () => {
  const layout = buildLayout("bus", { standard: 30000 });
  const { container } = render(<SeatMap layout={layout} currency="INR" />);
  expect(
    screen.getByRole("img", { name: "Passenger cabin seat layout" }),
  ).toBeTruthy();
  expect(container.querySelectorAll("svg [data-seat-index]")).toHaveLength(40);
  expect(screen.getAllByText(/A1.*A2.*A3.*A4/)).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: /book|reserve|hold/i }),
  ).toBeNull();
});

test("event detail displays factual publication and no booking affordance after the sale date", async () => {
  api.mockResolvedValue({
    serverTime: "2027-01-01T00:00:00Z",
    event: {
      id: "event",
      title: "Local program",
      type: "bus",
      venue: "Departure bay",
      description: "A scheduled departure.",
      status: "scheduled",
      isDemo: true,
      startsAt: "2027-01-02T00:00:00Z",
      saleStartsAt: "2026-12-31T00:00:00Z",
      lobbyOpensAt: "2026-12-30T23:50:00Z",
      timeZone: "UTC",
      currency: "INR",
      totalSeats: 40,
      layout: buildLayout("bus", { standard: 19999 }),
    },
  });
  show(<EventDetail />);
  await screen.findByRole("heading", { name: "Local program" });
  expect(screen.getByText("Demo event")).toBeTruthy();
  expect(screen.getByText("Booking is unavailable.")).toBeTruthy();
  const price = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "INR",
  }).format(199.99);
  expect(screen.getByText(price, { exact: true })).toBeTruthy();
});

const organizerDraft = {
  id: "id",
  title: "Trip draft",
  type: "bus",
  venue: "Station",
  description: "Scheduled departure",
  status: "draft",
  startsAt: "2027-01-02T00:00:00Z",
  saleStartsAt: "2026-12-31T00:00:00Z",
  timeZone: "UTC",
  currency: "INR",
  tierPrices: { standard: 30000 },
  revision: 0,
};

const organizer = { user: { id: "owner", role: "organizer", isGuest: false } };

function showOrganizerDraft() {
  window.sessionStorage.setItem(
    "queuetix.session",
    JSON.stringify({
      token: "organizer-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  show(
    <Routes>
      <Route path="/organizer/events/:id" element={<OrganizerEvent />} />
    </Routes>,
    "/organizer/events/id",
  );
}

test("an organizer saves the INR amount in paise and confirms the resulting revision", async () => {
  const draft = organizerDraft;
  api.mockImplementation(async (path, options) => {
    if (path === "/me") return organizer;
    if (options.method === "PATCH")
      return { event: { ...draft, ...options.body, revision: 1 } };
    if (path.endsWith("/publish"))
      return { event: { ...draft, status: "scheduled", totalSeats: 40 } };
    return { event: draft };
  });
  showOrganizerDraft();
  const title = await screen.findByLabelText("Title");
  fireEvent.change(title, { target: { value: "New title" } });
  fireEvent.change(screen.getByLabelText("Standard price (INR)"), {
    target: { value: "199.99" },
  });
  expect(screen.getByRole("button", { name: "Publish event" }).disabled).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByRole("heading", { name: "New title" });
  expect(api).toHaveBeenCalledWith(
    "/organizer/events/id",
    expect.objectContaining({
      method: "PATCH",
      body: expect.objectContaining({
        currency: "INR",
        tierPrices: { standard: 19999 },
      }),
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Publish event" }));
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/publish")),
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Confirm publication" }));
  await screen.findByText("Published · 40 seats");
  expect(
    api.mock.calls.filter(([path]) => path.endsWith("/publish")),
  ).toHaveLength(1);
  expect(api).toHaveBeenCalledWith(
    "/organizer/events/id/publish",
    expect.objectContaining({
      method: "POST",
      body: { revision: 1 },
    }),
  );
});

test("stale publication requires loading and reviewing the updated draft before reconfirming", async () => {
  let draft = organizerDraft;
  api.mockImplementation(async (path, options) => {
    if (path === "/me") return organizer;
    if (!path.endsWith("/publish")) return { event: draft };
    if (options.body?.revision !== 1) {
      draft = {
        ...draft,
        title: "Revised elsewhere",
        revision: 1,
        tierPrices: { standard: 19999 },
      };
      throw new ApiError(
        "This draft changed. Review the updated event before publishing.",
        409,
        "PUBLICATION_REVISION_CHANGED",
      );
    }
    return { event: { ...draft, status: "scheduled", totalSeats: 40 } };
  });
  const openPublish = () =>
    fireEvent.click(screen.getByRole("button", { name: "Publish event" }));
  const confirm = () =>
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm publication" }),
    );
  showOrganizerDraft();
  await screen.findByRole("heading", { name: "Trip draft" });
  openPublish();
  confirm();
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Review the updated event before publishing.",
  );
  expect(screen.getByRole("button", { name: "Publish event" }).disabled).toBe(
    true,
  );
  expect(
    screen.queryByRole("button", { name: "Confirm publication" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Load updated draft" }));
  await screen.findByRole("heading", { name: "Revised elsewhere" });
  expect(screen.getByLabelText("Standard price (INR)").value).toBe("199.99");
  expect(
    api.mock.calls
      .filter(([path]) => path.endsWith("/publish"))
      .map(([, options]) => options.body),
  ).toEqual([{ revision: 0 }]);
  openPublish();
  confirm();
  await screen.findByText("Published · 40 seats");
  expect(
    api.mock.calls
      .filter(([path]) => path.endsWith("/publish"))
      .map(([, options]) => options.body),
  ).toEqual([{ revision: 0 }, { revision: 1 }]);
});
