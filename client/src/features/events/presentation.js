export const statusNames = {
  draft: "Draft",
  scheduled: "Scheduled",
  lobby_open: "Lobby open",
  opening: "Opening",
  on_sale: "On sale",
  sold_out: "Sold out",
  ended: "Ended",
};

export function currencyDigits(currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
}

export function formatPrice(amount, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amount / 10 ** currencyDigits(currency));
}

export function formatDate(value, timeZone) {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(new Date(value));
}

export function pageNumber(query) {
  const value = Number(query.get("page"));
  return Number.isInteger(value) && value >= 1 && value <= 1000 ? value : 1;
}
