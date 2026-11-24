import { Schema } from "mongoose";
import { templates } from "../../../../shared/seat-layout.js";

export const publishedStatuses = [
  "scheduled",
  "lobby_open",
  "opening",
  "on_sale",
  "sold_out",
  "ended",
];

export const eventSchema = new Schema(
  {
    organizerId: { type: Schema.Types.ObjectId, required: true, ref: "User" },
    staffIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    title: { type: String, required: true },
    description: { type: String, required: true },
    venue: { type: String, required: true },
    type: { type: String, enum: Object.keys(templates), required: true },
    layout: { type: Schema.Types.Mixed, required: true },
    status: {
      type: String,
      enum: ["draft", ...publishedStatuses],
      default: "draft",
    },
    startsAt: { type: Date, required: true },
    timeZone: { type: String, required: true },
    currency: { type: String, required: true },
    lobbyOpensAt: { type: Date, required: true },
    saleStartsAt: { type: Date, required: true },
    maxActive: { type: Number, default: 10 },
    overAdmitBuffer: { type: Number, default: 2 },
    maxSeatsPerUser: { type: Number, default: 4 },
    holdSeconds: { type: Number, default: 300 },
    passSeconds: { type: Number, default: 600 },
    shuffleSeed: { type: String, default: null },
    lobbyJoinCount: { type: Number, default: 0 },
    lobbyCount: { type: Number, default: null },
    nextNumber: { type: Number, default: null },
    admittedUpTo: { type: Number, default: 0 },
    queueRevision: { type: Number, default: 0 },
    openingStartedAt: Date,
    onSaleAt: Date,
    soldOutCleanedAt: Date,
    totalSeats: { type: Number, default: 0 },
    isDemo: { type: Boolean, default: false },
    isSimulation: { type: Boolean, default: false },
    simRunId: String,
    revision: { type: Number, default: 0 },
  },
  { timestamps: true },
);

eventSchema.index({ status: 1, saleStartsAt: 1 });
eventSchema.index({ status: 1, lobbyOpensAt: 1 });
eventSchema.index({ status: 1, startsAt: 1 });
eventSchema.index({ organizerId: 1, updatedAt: -1, _id: -1 });
eventSchema.index({ isSimulation: 1, startsAt: 1, _id: 1 });
eventSchema.index({ staffIds: 1, startsAt: -1 });
