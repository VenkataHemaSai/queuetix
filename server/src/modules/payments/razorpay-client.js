const root = "https://api.razorpay.com/v1";

export class RazorpayRequestError extends Error {
  constructor(status) {
    super("Razorpay could not complete the request.");
    this.status = status;
  }
}

export function createRazorpayClient({ keyId, keySecret }, fetchImpl = fetch) {
  if (!/^rzp_test_[a-zA-Z0-9]{1,64}$/.test(keyId))
    throw new Error("A Razorpay Test Mode Key ID is required.");
  const Authorization =
    "Basic " + Buffer.from(keyId + ":" + keySecret).toString("base64");

  async function request(path, { body, refundKey } = {}) {
    try {
      const response = await fetchImpl(root + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization,
          Accept: "application/json",
          ...(body && { "Content-Type": "application/json" }),
          ...(refundKey && { "X-Refund-Idempotency": refundKey }),
        },
        ...(body && { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new RazorpayRequestError(response.status);
      return await response.json();
    } catch (error) {
      if (error instanceof RazorpayRequestError) throw error;
      throw new RazorpayRequestError();
    }
  }

  return {
    createOrder: (body) => request("/orders", { body }),
    findOrders: (receipt) =>
      request("/orders?" + new URLSearchParams({ receipt, count: "10" })),
    listPayments: (orderId) => request("/orders/" + orderId + "/payments"),
    getPayment: (paymentId) => request("/payments/" + paymentId),
    createRefund: (paymentId, body, key) =>
      request("/payments/" + paymentId + "/refund", { body, refundKey: key }),
    listRefunds: (paymentId) =>
      request("/payments/" + paymentId + "/refunds?count=100"),
    getRefund: (paymentId, refundId) =>
      request("/payments/" + paymentId + "/refunds/" + refundId),
  };
}
