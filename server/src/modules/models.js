import { userSchema } from "./auth/user.model.js";
import { eventSchema } from "./events/event.model.js";
import { seatSchema } from "./events/seat.model.js";

export async function initializeModels(connection) {
  const models = {
    User: connection.model("User", userSchema),
    Event: connection.model("Event", eventSchema),
    Seat: connection.model("Seat", seatSchema),
  };
  await Promise.all(Object.values(models).map((model) => model.init()));
  return models;
}
