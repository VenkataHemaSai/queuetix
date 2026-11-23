import { z } from "zod";

const strongKey = z
  .string()
  .min(32)
  .refine((value) => value === value.trim());

function isOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

const schema = z
  .object({
    CLIENT_ORIGIN: z
      .string()
      .transform((input) => [
        ...new Set(input.split(",").map((value) => value.trim())),
      ])
      .refine((origins) => origins.every(isOrigin)),
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\/[^\s]+$/),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    JWT_SECRET: z
      .string()
      .min(32)
      .refine((value) => value === value.trim()),
    GOOGLE_CLIENT_ID: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^[\w-]+\.apps\.googleusercontent\.com$/)
        .optional(),
    ),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(2).default(0),
    PAYMENT_WEBHOOK_SECRET: strongKey,
    QR_HMAC_SECRET: strongKey,
    ENABLE_DEV_TOOLS: z.enum(["true", "false"]).default("false"),
    PAYMENT_PROVIDER: z.enum(["mock", "razorpay"]).default("mock"),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((config, context) => {
    if (config.PAYMENT_PROVIDER !== "razorpay") return;
    const requirements = {
      RAZORPAY_KEY_ID: /^rzp_test_[a-zA-Z0-9]{1,64}$/,
      RAZORPAY_KEY_SECRET: /^\S{16,256}$/,
      RAZORPAY_WEBHOOK_SECRET: /^\S{24,256}$/,
    };
    for (const [key, pattern] of Object.entries(requirements)) {
      if (!pattern.test(config[key] ?? ""))
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Invalid Test Mode configuration",
        });
    }
  });

export function readEnv(source) {
  const result = schema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map(({ path }) => path[0]))];
    throw new Error(`Invalid environment variables: ${keys.join(", ")}`);
  }
  return {
    clientOrigins: result.data.CLIENT_ORIGIN,
    mongoUri: result.data.MONGODB_URI,
    nodeEnv: result.data.NODE_ENV,
    port: result.data.PORT,
    jwtSecret: result.data.JWT_SECRET,
    googleClientId: result.data.GOOGLE_CLIENT_ID,
    trustProxy: result.data.TRUST_PROXY_HOPS,
    paymentWebhookSecret: result.data.PAYMENT_WEBHOOK_SECRET,
    qrHmacSecret: result.data.QR_HMAC_SECRET,
    paymentProvider: result.data.PAYMENT_PROVIDER,
    ...(result.data.PAYMENT_PROVIDER === "razorpay" && {
      razorpay: {
        keyId: result.data.RAZORPAY_KEY_ID,
        keySecret: result.data.RAZORPAY_KEY_SECRET,
        webhookSecret: result.data.RAZORPAY_WEBHOOK_SECRET,
      },
    }),
    enableDevTools:
      result.data.NODE_ENV === "development" &&
      result.data.ENABLE_DEV_TOOLS === "true",
  };
}
