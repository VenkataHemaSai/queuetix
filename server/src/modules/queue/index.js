import { withTxn } from "../../lib/db.js";
import { createBooking } from "../booking/index.js";
import { createQueueHub } from "./hub.js";
import { createPresence } from "./presence.js";
import { createOpening } from "./opening.js";
import { createQueueService } from "./service.js";
import { createQueueLifecycle } from "./lifecycle.js";

export function createQueueRuntime(options) {
  const hub = createQueueHub();
  const presence = createPresence();
  const report = options.report ?? (() => {});
  const context = {
    ...options,
    presence,
    publish: hub.publish,
    report,
    transaction: (work) => withTxn(work, options),
  };
  const booking = createBooking({
    ...context,
    queueEntries: options.QueueEntry,
  });
  const service = createQueueService({ ...context, booking });
  const opening = createOpening({ ...context, inventory: service.inventory });
  const lifecycle = createQueueLifecycle({
    ...context,
    booking,
    queue: service,
    opening,
    presence,
  });
  const queue = {
    ...service,
    ...opening,
    ...lifecycle,
    presence,
    subscribe: hub.subscribe,
    clock: options.clock,
  };
  return { ...lifecycle, booking, queue, presence };
}
