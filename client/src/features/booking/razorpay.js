import { PRODUCT_NAME } from "../../product.js";

let loading;
function loadCheckout() {
  if (typeof window.Razorpay === "function") return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.async = true;
      script.referrerPolicy = "no-referrer";
      const timer = setTimeout(failed, 12_000);
      function failed() {
        clearTimeout(timer);
        script.remove();
        reject(new Error("Razorpay Test Mode could not load. Try again."));
      }
      script.addEventListener("error", failed, { once: true });
      script.addEventListener(
        "load",
        () => {
          clearTimeout(timer);
          if (typeof window.Razorpay === "function") resolve();
          else failed();
        },
        { once: true },
      );
      document.head.append(script);
    }).catch((error) => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
}

export async function openRazorpay(config, { signal, onFailure }) {
  await loadCheckout();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const settle = (value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const checkout = new window.Razorpay({
      key: config.keyId,
      amount: config.amount,
      currency: config.currency,
      order_id: config.orderId,
      name: PRODUCT_NAME,
      description: "QueueTix Test Mode booking",
      handler: settle,
      modal: { ondismiss: () => settle(null) },
    });
    function abort() {
      reject(signal.reason);
      checkout.close();
    }
    signal.addEventListener("abort", abort, { once: true });
    checkout.on("payment.failed", () => {
      if (!signal.aborted) onFailure();
    });
    try {
      checkout.open();
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
    }
  });
}
