import { Schema } from "mongoose";

const ref = { type: Schema.Types.ObjectId, required: true };
const string = { type: String, required: true };
const date = { type: Date, required: true };
const amount = { type: Number, required: true };
const seatIds = { type: [Schema.Types.ObjectId], required: true };
const state = (values) => ({
  type: String,
  enum: values,
  default: values[0],
  required: true,
});
const owner = { eventId: ref, userId: ref };
const active = { unique: true, partialFilterExpression: { status: "active" } };

const pass = new Schema({
  ...owner,
  issuedAt: date,
  expiresAt: date,
  status: state(["active", "used", "expired"]),
});
pass.index({ eventId: 1, userId: 1 }, active);
pass.index({ status: 1, expiresAt: 1 });
pass.index({ eventId: 1, status: 1, expiresAt: 1 });

const quota = new Schema({
  ...owner,
  held: { type: Number, default: 0 },
  bought: { type: Number, default: 0 },
  revision: { type: Number, default: 0 },
});
quota.index({ eventId: 1, userId: 1 }, { unique: true });

const hold = new Schema({
  ...owner,
  passId: ref,
  seatIds,
  expiresAt: date,
  status: state(["active", "released", "expired", "converted"]),
  idempotencyKey: String,
  requestFingerprint: String,
});
hold.index({ eventId: 1, userId: 1 }, active);
hold.index(
  { userId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);
hold.index({ status: 1, expiresAt: 1 });
hold.index({ eventId: 1, status: 1, expiresAt: 1 });

const line = new Schema(
  { seatId: ref, label: string, section: string, tier: string, price: amount },
  { _id: false },
);
const order = new Schema(
  {
    ...owner,
    holdId: ref,
    passId: ref,
    holdExpiresAt: date,
    seatIds,
    seatLines: [line],
    amount,
    currency: string,
    idempotencyKey: string,
    requestFingerprint: string,
    status: state(["pending", "paid", "failed"]),
    failureReason: String,
  },
  { timestamps: true },
);
order.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
order.index({ holdId: 1 }, { unique: true });
order.index({ eventId: 1, status: 1 });
order.index(
  { eventId: 1, userId: 1 },
  { unique: true, partialFilterExpression: { status: "paid" } },
);

const orderKey = new Schema({
  ...owner,
  orderId: ref,
  idempotencyKey: string,
  requestFingerprint: string,
});
orderKey.index({ userId: 1, idempotencyKey: 1 }, { unique: true });

const payment = new Schema({
  eventId: ref,
  orderId: ref,
  providerRef: string,
  requestFingerprint: string,
  outcome: state(["succeeded", "failed"]),
  status: state(["processed", "refunded", "failed"]),
  reason: String,
  amount,
  processedAt: date,
});
payment.index({ providerRef: 1 }, { unique: true });
payment.index({ orderId: 1, processedAt: -1, _id: -1 });

const ticket = new Schema({
  ...owner,
  orderId: ref,
  seatId: ref,
  qrPayload: string,
  status: state(["valid", "used"]),
  issuedAt: date,
  scannedAt: Date,
});
ticket.index({ eventId: 1, seatId: 1 }, { unique: true });
ticket.index({ userId: 1, issuedAt: -1, _id: -1 });

const audit = new Schema(
  {
    ...owner,
    orderId: Schema.Types.ObjectId,
    holdId: Schema.Types.ObjectId,
    action: string,
    at: date,
  },
  { collection: "auditLog" },
);
audit.index({ eventId: 1, at: 1 });

export const bookingSchemas = {
  Pass: pass,
  Quota: quota,
  Hold: hold,
  Order: order,
  OrderKey: orderKey,
  Payment: payment,
  Ticket: ticket,
  AuditLog: audit,
};
