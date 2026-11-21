export function mongoDiagnostic(error, mongoUri = "") {
  const redact = (value) => {
    let message = String(value).replace(
      /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
      "[redacted MongoDB URI]",
    );
    const login = /^mongodb(?:\+srv)?:\/\/([^/@]+)@/i.exec(mongoUri)?.[1];
    if (login) {
      const secrets = new Set();
      for (const part of login.split(":").filter(Boolean)) {
        secrets.add(part);
        try {
          secrets.add(decodeURIComponent(part));
        } catch {
          // An invalid escape can only occur in the URL-encoded spelling.
        }
      }
      for (const secret of secrets) {
        const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        message = message.replace(
          new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g"),
          "[redacted]",
        );
      }
    }
    return message
      .replace(
        /\b(?:[a-z\d-]+\.)+[a-z]{2,}(?::\d+)?\b|\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b|\[[a-f\d:]*:[a-f\d:]+\](?::\d+)?/gi,
        "[redacted host]",
      )
      .slice(0, 1000);
  };
  return {
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message: redact(error?.message ?? error),
    labels: error?.errorLabels ?? [],
    ...(error?.cause && { cause: mongoDiagnostic(error.cause, mongoUri) }),
  };
}
