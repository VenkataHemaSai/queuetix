import { Schema } from "mongoose";

export const roles = ["attendee", "organizer", "admin", "staff"];

export const userSchema = new Schema(
  {
    email: { type: String, required: true },
    name: { type: String, required: true },
    googleId: String,
    isBot: Boolean,
    simRunId: String,
    role: { type: String, enum: roles, default: "attendee", required: true },
    isGuest: { type: Boolean, default: false, required: true },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleId: 1 }, { sparse: true, unique: true });
