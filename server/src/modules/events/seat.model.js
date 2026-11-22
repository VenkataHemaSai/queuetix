import { Schema } from "mongoose";

export const seatSchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, required: true, ref: "Event" },
  label: { type: String, required: true },
  section: { type: String, required: true },
  row: { type: Number, required: true },
  col: { type: Number, required: true },
  tier: { type: String, required: true },
  price: { type: Number, required: true },
  window: Boolean,
  seatIndex: { type: Number, required: true },
  status: {
    type: String,
    enum: ["available", "held", "sold"],
    default: "available",
  },
  holdId: { type: Schema.Types.ObjectId, default: null },
  holdExpiresAt: { type: Date, default: null },
  orderId: { type: Schema.Types.ObjectId, default: null },
});

seatSchema.index({ eventId: 1, label: 1 }, { unique: true });
seatSchema.index({ eventId: 1, status: 1 });
seatSchema.index({ eventId: 1, holdId: 1 });
