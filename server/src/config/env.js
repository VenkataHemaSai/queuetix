import { z } from "zod";

function isOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}

const schema = z.object({
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
  };
}
