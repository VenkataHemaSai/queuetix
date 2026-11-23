import { Schema } from "mongoose";

export const queueEntrySchema = new Schema({
  eventId: { type: Schema.Types.ObjectId, required: true, ref: "Event" },
  userId: { type: Schema.Types.ObjectId, required: true, ref: "User" },
  number: { type: Number, default: null },
  status: {
    type: String,
    enum: [
      "lobby",
      "waiting",
      "admitted",
      "abandoned",
      "expired",
      "expired_soldout",
      "completed",
    ],
    required: true,
  },
  joinedInLobby: { type: Boolean, default: false },
  joinedAt: { type: Date, required: true },
  rejoinCount: { type: Number, default: 0 },
  rejoinKey: String,
  passId: { type: Schema.Types.ObjectId, ref: "Pass" },
});

queueEntrySchema.index({ eventId: 1, userId: 1 }, { unique: true });
queueEntrySchema.index(
  { eventId: 1, number: 1 },
  { unique: true, partialFilterExpression: { number: { $type: "number" } } },
);
queueEntrySchema.index({ eventId: 1, status: 1, number: 1 });
queueEntrySchema.index({ status: 1, passId: 1 });
