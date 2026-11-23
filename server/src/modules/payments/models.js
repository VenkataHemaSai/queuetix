import { Schema } from "mongoose";

const objectId = Schema.Types.ObjectId;
const requiredString = { type: String, required: true };
const money = {
  amount: { type: Number, required: true },
  currency: requiredString,
};
const orderRef = { type: objectId, ref: "Order", required: true };
const gatewayOrder = new Schema({
  _id: orderRef,
  receipt: requiredString,
  ...money,
  gatewayOrderId: String,
  submittedAt: Date,
  nextCheckAt: Date,
});
gatewayOrder.index({ receipt: 1 }, { unique: true });
gatewayOrder.index({ gatewayOrderId: 1 }, { unique: true, sparse: true });
gatewayOrder.index({ nextCheckAt: 1 });

const gatewayAttempt = new Schema({
  _id: requiredString,
  orderId: orderRef,
  ...money,
  status: requiredString,
  checkedAt: Date,
  settledAt: Date,
});
gatewayAttempt.index({ orderId: 1, checkedAt: -1 });

const gatewayEvent = new Schema({
  _id: requiredString,
  orderId: orderRef,
  paymentId: requiredString,
  eventType: requiredString,
  bodyHash: requiredString,
  processedAt: Date,
});
gatewayEvent.index({ orderId: 1 });

const gatewayRefund = new Schema({
  _id: requiredString,
  orderId: orderRef,
  receipt: requiredString,
  ...money,
  reason: requiredString,
  status: {
    type: String,
    enum: ["requested", "unknown", "pending", "processed", "failed"],
    required: true,
  },
  refundId: String,
  nextCheckAt: Date,
  checkedAt: Date,
});
gatewayRefund.index({ refundId: 1 }, { unique: true, sparse: true });
gatewayRefund.index({ nextCheckAt: 1 });

export const paymentGatewaySchemas = {
  GatewayOrder: gatewayOrder,
  GatewayAttempt: gatewayAttempt,
  GatewayEvent: gatewayEvent,
  GatewayRefund: gatewayRefund,
};
