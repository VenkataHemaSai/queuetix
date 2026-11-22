import { z } from "zod";
import { templates } from "../../../../shared/seat-layout.js";

const supported = new Set(Intl.supportedValuesOf("currency"));
const date = z.iso.datetime({ offset: true });
const integer = (min, max) => z.number().int().min(min).max(max);
const text = (max) => z.string().trim().min(1).max(max);
const field = (context, key, message) =>
  context.addIssue({ code: "custom", path: key.split("."), message });

const eventFields = z.strictObject({
  title: text(120),
  description: text(3000),
  venue: text(160),
  type: z.enum(Object.keys(templates)),
  startsAt: date,
  saleStartsAt: date,
  timeZone: text(100).refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, "Enter an IANA time zone."),
  currency: z
    .string()
    .refine(
      (value) => supported.has(value),
      "Enter a supported ISO currency code.",
    ),
  tierPrices: z.record(z.string(), integer(0, 100_000_000)),
  isDemo: z.boolean().default(false),
  maxActive: integer(1, 500).default(10),
  overAdmitBuffer: integer(0, 500).default(2),
  maxSeatsPerUser: integer(1, 4).default(4),
  holdSeconds: integer(30, 1800).default(300),
  passSeconds: integer(60, 3600).default(600),
});

function checkEvent(input, context) {
  if (Date.parse(input.saleStartsAt) >= Date.parse(input.startsAt)) {
    field(
      context,
      "saleStartsAt",
      "Sale start must be before the event starts.",
    );
  }
  const tiers = templates[input.type].tiers;
  for (const tier of tiers) {
    if (!Object.hasOwn(input.tierPrices, tier))
      field(context, `tierPrices.${tier}`, "Enter a price for this tier.");
  }
  if (Object.keys(input.tierPrices).some((tier) => !tiers.includes(tier))) {
    field(
      context,
      "tierPrices",
      "Prices must match the selected layout's tiers.",
    );
  }
}

export const createEventInput = eventFields.superRefine(checkEvent);
const draftRevision = integer(0, Number.MAX_SAFE_INTEGER);
export const editEventInput = eventFields
  .extend({ revision: draftRevision })
  .superRefine(checkEvent);
export const publishEventInput = z.strictObject({ revision: draftRevision });
export const eventId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid event ID.");
export const pageInput = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(48).default(12),
});
