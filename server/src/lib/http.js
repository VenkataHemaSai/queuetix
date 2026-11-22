export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    Object.assign(this, { status, code, fields });
  }
}

export function validate(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = {};
  for (const { path, message } of result.error.issues)
    fields[path.join(".") || "body"] ??= message;
  throw new HttpError(
    400,
    "INVALID_INPUT",
    "Check the submitted fields.",
    fields,
  );
}
