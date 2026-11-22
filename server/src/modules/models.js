import { userSchema } from "./auth/user.model.js";
import { eventSchema } from "./events/event.model.js";
import { seatSchema } from "./events/seat.model.js";
import { bookingSchemas } from "./booking/models.js";

export async function initializeModels(connection) {
  const models = {
    User: connection.model("User", userSchema),
    Event: connection.model("Event", eventSchema),
    Seat: connection.model("Seat", seatSchema),
    ...Object.fromEntries(
      Object.entries(bookingSchemas).map(([name, schema]) => [
        name,
        connection.model(
          name,
          schema,
          name === "Quota" ? "userQuotas" : undefined,
        ),
      ]),
    ),
  };
  await Promise.all(Object.values(models).map((model) => model.init()));
  return models;
}
