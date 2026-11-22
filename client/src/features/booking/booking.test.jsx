// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { buildLayout } from "../../../../shared/seat-layout.js";
import { api, ApiError } from "../../lib/api.js";
import { SessionProvider } from "../auth/session.jsx";
import { BookingPage } from "./BookingPage.jsx";
import { CheckoutPage } from "./CheckoutPage.jsx";
import { TicketsPage } from "./TicketsPage.jsx";

vi.mock("../../lib/api.js", async (original) => ({
  ...(await original()),
  api: vi.fn(),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,test") },
}));

const user = {
  id: "guest",
  role: "attendee",
  isGuest: true,
  name: "Demo guest",
};
const serverTime = "2027-01-01T12:00:00Z";
const expiresAt = "2027-01-01T12:05:00Z";
const event = {
  id: "event",
  title: "Night bus",
  venue: "Terminal",
  status: "on_sale",
  saleStartsAt: "2026-12-30T12:00:00Z",
  startsAt: "2027-01-02T12:00:00Z",
  timeZone: "UTC",
  currency: "INR",
  isDemo: true,
  layout: buildLayout("bus", { standard: 19999 }),
};
const seats = [
  {
    id: "one",
    seatIndex: 0,
    label: "A1",
    tier: "standard",
    price: 19999,
    status: "available",
    mine: false,
  },
  {
    id: "two",
    seatIndex: 1,
    label: "A2",
    tier: "standard",
    price: 19999,
    status: "available",
    mine: false,
  },
  {
    id: "four",
    seatIndex: 3,
    label: "A4",
    tier: "standard",
    price: 19999,
    status: "sold",
    mine: false,
  },
];
const order = {
  id: "order",
  eventId: "event",
  status: "pending",
  holdId: "hold",
  holdExpiresAt: expiresAt,
  seats: [{ seatId: "one", label: "A1", tier: "standard", price: 19999 }],
  currency: "INR",
  amount: 19999,
};

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.resetAllMocks();
});

function show(path, route, element) {
  window.sessionStorage.setItem(
    "queuetix.session",
    JSON.stringify({
      token: "test-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <SessionProvider>
          <Routes>
            <Route path={route} element={element} />
          </Routes>
        </SessionProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

test("keyboard selection and a hold conflict preserve seats that remain available", async () => {
  let conflicted = false;
  api.mockImplementation(async (path) => {
    if (path === "/me") return { user };
    if (path === "/events/event") return { event, serverTime };
    if (path.endsWith("/booking"))
      return {
        pass: { expiresAt },
        hold: null,
        order: null,
        serverTime,
        maxSeatsPerUser: 4,
      };
    if (path.endsWith("/seats"))
      return {
        seats: conflicted
          ? [{ ...seats[0], status: "held" }, ...seats.slice(1)]
          : seats,
      };
    if (path.endsWith("/holds")) {
      conflicted = true;
      throw new ApiError(
        "Some of the selected seats are unavailable.",
        409,
        "SEAT_UNAVAILABLE",
        { labels: ["A1"] },
      );
    }
    throw new Error("Unexpected fixture request");
  });
  show("/events/event/book", "/events/:id/book", <BookingPage />);
  const first = await screen.findByRole("button", { name: /Seat A1/ });
  fireEvent.keyDown(first, { key: " " });
  fireEvent.click(screen.getByRole("button", { name: /Seat A2/ }));
  expect(screen.queryByRole("button", { name: /Seat A4/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hold seats" }));
  await screen.findByText(
    "Seat A1 is unavailable. Review your remaining selection.",
  );
  await waitFor(() => {
    expect(
      screen
        .getByRole("button", { name: /Seat A2/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: /Seat A1/ })).toBeNull();
  });
  expect(api).toHaveBeenCalledWith(
    "/events/event/holds",
    expect.objectContaining({
      body: { seatIds: ["one", "two"], idempotencyKey: expect.any(String) },
    }),
  );
});

test("an empty cinema inventory shows a retry instead of a layout that looks bookable", async () => {
  const cinema = {
    ...event,
    title: "Cinema preview",
    layout: buildLayout("cinema", {
      front: 19999,
      standard: 29999,
      premium: 49999,
    }),
  };
  const inventory = [
    { ...seats[0], tier: "front" },
    { ...seats[1], status: "held", tier: "front" },
    { ...seats[2], label: "A3", seatIndex: 2, tier: "front" },
    {
      ...seats[0],
      id: "row-d",
      label: "D1",
      seatIndex: 36,
      price: 29999,
    },
  ];
  let inventoryAvailable = false;
  api.mockImplementation(async (path) => {
    if (path === "/me") return { user };
    if (path === "/events/event") return { event: cinema, serverTime };
    if (path.endsWith("/booking"))
      return {
        pass: { expiresAt },
        hold: null,
        order: null,
        serverTime,
        maxSeatsPerUser: 4,
      };
    if (path.endsWith("/seats"))
      return { seats: inventoryAvailable ? inventory : [] };
    throw new Error("Unexpected fixture request");
  });

  show("/events/event/book", "/events/:id/book", <BookingPage />);
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Seat inventory is unavailable");
  expect(screen.queryByRole("group", { name: /seat layout/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Hold seats" })).toBeNull();

  inventoryAvailable = true;
  fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
  const map = await screen.findByRole("group", {
    name: "Main auditorium seat layout",
  });
  const first = within(map).getByRole("button", { name: /Seat A1,/ });
  const fourthRow = within(map).getByRole("button", { name: /Seat D1,/ });
  const selection = screen.getByRole("heading", {
    name: "Your selection",
  }).parentElement;
  const total = () =>
    selection.querySelector(".booking-total strong").textContent;
  const hold = within(selection).getByRole("button", { name: "Hold seats" });
  expect(total()).toBe("₹0.00");
  expect(hold.disabled).toBe(true);

  fireEvent.click(first.querySelector("rect"));
  expect(first.getAttribute("aria-pressed")).toBe("true");
  expect(within(selection).getByText("A1 · Front")).toBeTruthy();
  expect(total()).toBe("₹199.99");
  expect(hold.disabled).toBe(false);

  for (const [index, state] of [
    [1, "held"],
    [2, "sold"],
  ]) {
    const seat = map.querySelector(`[data-seat-index="${index}"]`);
    expect(seat.dataset.bookingState).toBe(state);
    expect(seat.hasAttribute("tabindex")).toBe(false);
    fireEvent.click(seat.querySelector("rect"));
  }
  expect(total()).toBe("₹199.99");

  fourthRow.focus();
  expect(document.activeElement).toBe(fourthRow);
  fireEvent.keyDown(fourthRow, { key: "Enter" });
  expect(fourthRow.getAttribute("aria-pressed")).toBe("true");
  expect(within(selection).getByText("D1 · Standard")).toBeTruthy();
  expect(total()).toBe("₹499.98");

  fireEvent.click(first.querySelector("text"));
  expect(first.getAttribute("aria-pressed")).toBe("false");
  expect(within(selection).queryByText("A1 · Front")).toBeNull();
  expect(total()).toBe("₹299.99");
  fireEvent.keyDown(fourthRow, { key: " " });
  expect(fourthRow.getAttribute("aria-pressed")).toBe("false");
  expect(within(selection).queryByText("D1 · Standard")).toBeNull();
  expect(total()).toBe("₹0.00");
  expect(hold.disabled).toBe(true);
});

test("checkout confirms a booking only after the server returns a paid order", async () => {
  let confirm;
  const pending = new Promise((resolve) => {
    confirm = resolve;
  });
  api.mockImplementation(async (path) => {
    if (path === "/me") return { user };
    if (path.endsWith("/mock")) return pending;
    return { order, holdActive: true, serverTime };
  });
  show("/checkout/order", "/checkout/:id", <CheckoutPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
  expect(screen.getByText("Checking booking status…")).toBeTruthy();
  expect(
    screen.queryByRole("heading", { name: "Booking confirmed" }),
  ).toBeNull();
  confirm({
    order: { ...order, status: "paid" },
    payment: { status: "processed" },
  });
  await screen.findByRole("heading", { name: "Booking confirmed" });
  expect(
    screen.getByRole("link", { name: "View my tickets" }).getAttribute("href"),
  ).toBe("/tickets");
});

test("checkout reconciles an unresolved payment through order status without resubmitting", async () => {
  let paid = false;
  api.mockImplementation(async (path) => {
    if (path === "/me") return { user };
    if (path === "/orders/order/mock")
      throw new ApiError(
        "The result could not be confirmed.",
        503,
        "TXN_COMMIT_UNCONFIRMED",
      );
    if (path === "/orders/order")
      return {
        order: { ...order, status: paid ? "paid" : "pending" },
        holdActive: !paid,
        serverTime,
      };
    throw new Error("Unexpected fixture request");
  });

  show("/checkout/order", "/checkout/:id", <CheckoutPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
  const checkStatus = await screen.findByRole("button", {
    name: "Check booking status",
  });
  expect(screen.queryByRole("button", { name: "Pay" })).toBeNull();
  expect(
    screen.queryByRole("heading", { name: "Booking confirmed" }),
  ).toBeNull();

  paid = true;
  fireEvent.click(checkStatus);
  await screen.findByRole("heading", { name: "Booking confirmed" });
  expect(
    api.mock.calls.filter(([path]) => path === "/orders/order/mock"),
  ).toHaveLength(1);
});

test("My tickets displays the server's confirmed seat, order link and QR", async () => {
  api.mockImplementation(async (path) =>
    path === "/me"
      ? { user }
      : {
          tickets: [
            {
              id: "ticket",
              status: "valid",
              qrPayload: "fixture.signed",
              event,
              seat: { label: "A1", section: "main", price: 19999 },
              order: { id: "order", currency: "INR" },
            },
          ],
          page: 1,
          hasNext: false,
        },
  );
  show("/tickets", "/tickets", <TicketsPage />);
  await screen.findByText("A1 · Section MAIN");
  expect(
    screen
      .getByRole("link", { name: "View confirmed order" })
      .getAttribute("href"),
  ).toBe("/checkout/order");
  expect(
    (
      await screen.findByRole("img", { name: "Ticket QR code for entry" })
    ).getAttribute("src"),
  ).toMatch(/^data:image\/png/);
});
