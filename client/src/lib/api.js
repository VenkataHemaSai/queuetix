import { readApiOrigin } from "../smoke/probes.js";
import { fetchEventSource } from "@microsoft/fetch-event-source";

const origin = readApiOrigin(import.meta.env.VITE_API_URL);

export class ApiError extends Error {
  constructor(message, status, code, fields, retryAfter = 0) {
    super(message);
    Object.assign(this, { status, code, fields, retryAfter });
  }
}

export async function stream(
  path,
  { token, signal, onMessage, onOpen, onDisconnect },
) {
  if (!origin) throw new ApiError("The service is not configured.", 503);
  let delay = 1000;
  return fetchEventSource(origin + path, {
    signal,
    openWhenHidden: true,
    headers: { Authorization: "Bearer " + token },
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    async onopen(response) {
      if (
        response.ok &&
        response.headers.get("Content-Type")?.includes("text/event-stream")
      ) {
        delay = 1000;
        onOpen?.();
        return;
      }
      const { error } = await response.json().catch(() => ({}));
      throw new ApiError(
        error?.message ?? "The live connection is unavailable.",
        response.status,
        error?.code,
        error?.fields,
        Number(response.headers.get("Retry-After")) || 0,
      );
    },
    onmessage: onMessage,
    onclose() {
      throw new Error("The live connection closed.");
    },
    onerror(error) {
      onDisconnect?.(error);
      if (error.status >= 400 && error.status < 500 && error.status !== 429)
        throw error;
      const retry = Math.max(delay, (error.retryAfter ?? 0) * 1000);
      delay = Math.min(15000, delay * 2);
      return retry;
    },
  });
}

export async function api(path, { method = "GET", body, token, signal } = {}) {
  if (!origin) throw new ApiError("The service is not configured.", 503);
  const timeout = AbortSignal.timeout(90_000);
  let response;
  try {
    response = await fetch(`${origin}${path}`, {
      method,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.headers.get("content-type")?.includes("application/json")) {
      const result = await response.json();
      if (response.ok) return result;
      const { message, code, fields } = result?.error ?? {};
      const retryAfter = Number(response.headers.get("Retry-After")) || 0;
      throw new ApiError(
        message || "The service could not complete the request.",
        response.status,
        code,
        fields,
        retryAfter,
      );
    }
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    throw new ApiError(
      timeout.aborted
        ? "The service took too long to respond."
        : "Could not reach the service. Check your connection.",
      503,
    );
  }
  throw new ApiError(
    "The service returned an unexpected response. Try again shortly.",
    response.status,
  );
}
