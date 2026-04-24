type LogLevel = "info" | "warn" | "error";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /(auth|token|password|secret|authorization)/i;
const BEARER_PATTERN = /Bearer\s+[^\s"']+/gi;
const KEY_VALUE_PATTERN =
  /((?:auth|token|password|secret|authorization)[a-zA-Z0-9_-]*=)([^,\s]+)/gi;

export function logServerEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = {
    scope: "ladybug-server",
    level,
    event,
    ...sanitizeRecord(fields),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  if (level === "warn") {
    console.warn(line);
    return;
  }
  console.log(line);
}

function sanitizeRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, sanitizeField(key, value)]),
  );
}

function sanitizeField(key: string, value: unknown): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return REDACTED;
  }
  return sanitizeValue(value);
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeString(value);
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeString(value.message),
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }
  if (value && typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>);
  }
  return value;
}

function sanitizeString(value: string): string {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(KEY_VALUE_PATTERN, `$1${REDACTED}`);
}
