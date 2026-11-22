import { withTxn } from "../../lib/db.js";
import { createAdmission } from "./admission.js";
import { createHolds } from "./holds.js";
import { createCheckout } from "./checkout.js";
import { createIntegrity } from "./integrity.js";
import { createInventory } from "./inventory.js";

export function createBooking(options) {
  const context = { ...options, transaction: (work) => withTxn(work, options) };
  const admission = createAdmission(context);
  const holds = createHolds({ ...context, activePass: admission.activePass });
  const checkout = createCheckout({ ...context, retireHold: holds.retireHold });
  return {
    ...admission,
    ...holds,
    ...checkout,
    ...createInventory({ ...context, activePass: admission.activePass }),
    verifyEventIntegrity: createIntegrity(context),
  };
}
