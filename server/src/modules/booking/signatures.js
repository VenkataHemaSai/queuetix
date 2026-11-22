import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function fingerprint(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function signPayload(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function validSignature(payload, signature, secret) {
  return (
    typeof signature === "string" &&
    /^[a-f\d]{64}$/i.test(signature) &&
    timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(signPayload(payload, secret), "hex"),
    )
  );
}

export function signTicketPayload(id, secret) {
  const ticketId = String(id);
  return `${ticketId}.${signPayload(ticketId, secret)}`;
}

export function verifyTicketPayload(payload, secret) {
  const match =
    typeof payload === "string" &&
    /^([a-f\d]{24})\.([a-f\d]{64})$/i.exec(payload);
  return match && validSignature(match[1], match[2], secret) ? match[1] : null;
}
