export type PushRequestOperation = "check" | "register";

export type PushRequestCategory =
  | "request_started"
  | "response_received"
  | "success"
  | "not_connected"
  | "http_non_200"
  | "backend_nonzero"
  | "malformed_body"
  | "transport_error";

export type PushRequestErrorClass =
  | "http_error"
  | "request_error"
  | "timeout_error"
  | "parse_error"
  | "read_error"
  | "type_error"
  | "error"
  | "unknown_error";

export interface PushRequestDiagnostic {
  operation: PushRequestOperation;
  category: PushRequestCategory;
  httpStatus?: number;
  backendCode?: number;
  errorClass?: PushRequestErrorClass;
}

const checkEndpoint = "v1/app/review/app_push_check";
const registerEndpoint = "v1/apppush/register_push_token";

export function pushOperationFromEndpoint(endpoint: unknown): PushRequestOperation | undefined {
  if (endpoint === checkEndpoint) return "check";
  if (endpoint === registerEndpoint) return "register";
  return undefined;
}

export function pushOperationFromUrl(url: unknown): PushRequestOperation | undefined {
  try {
    const pathname = url instanceof URL ? url.pathname : typeof url === "string" ? new URL(url).pathname : "";
    if (pathname.endsWith(`/${checkEndpoint}`)) return "check";
    if (pathname.endsWith(`/${registerEndpoint}`)) return "register";
  } catch {
    // Invalid URLs have no operation classification.
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorClass(error: unknown): PushRequestErrorClass {
  try {
    let current = error;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof current !== "object" || current === null) return "unknown_error";
      const candidate = current as { name?: unknown; cause?: unknown };
      switch (candidate.name) {
        case "ApiRequestError":
          if (candidate.cause !== undefined) {
            current = candidate.cause;
            continue;
          }
          return "request_error";
        case "HTTPError":
        case "EufyApiError":
          return "http_error";
        case "RequestError":
          return "request_error";
        case "TimeoutError":
          return "timeout_error";
        case "ParseError":
          return "parse_error";
        case "ReadError":
          return "read_error";
        case "TypeError":
          return "type_error";
        case "Error":
          return "error";
        default:
          return "unknown_error";
      }
    }
  } catch {
    // Exception properties are untrusted and never become log values.
  }
  return "unknown_error";
}

/** Project untrusted response/error values into a fixed, credential-free log surface. */
export function projectPushRequestDiagnostic(
  operation: PushRequestOperation,
  category: PushRequestCategory,
  details: { httpStatus?: unknown; backendCode?: unknown; error?: unknown } = {}
): PushRequestDiagnostic {
  const diagnostic: PushRequestDiagnostic = {
    operation: operation === "register" ? "register" : "check",
    category: "transport_error",
  };
  switch (category) {
    case "request_started":
    case "response_received":
    case "success":
    case "not_connected":
    case "http_non_200":
    case "backend_nonzero":
    case "malformed_body":
    case "transport_error":
      diagnostic.category = category;
  }
  const httpStatus = finiteNumber(details.httpStatus);
  const backendCode = finiteNumber(details.backendCode);
  if (httpStatus !== undefined) diagnostic.httpStatus = httpStatus;
  if (backendCode !== undefined) diagnostic.backendCode = backendCode;
  if (details.error !== undefined) diagnostic.errorClass = errorClass(details.error);
  return diagnostic;
}

export function describePushResponse(
  operation: PushRequestOperation,
  httpStatus: unknown,
  body: unknown
): PushRequestDiagnostic {
  if (httpStatus != 200) {
    return projectPushRequestDiagnostic(operation, "http_non_200", { httpStatus });
  }
  let backendCode: number | undefined;
  try {
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      backendCode = finiteNumber(Object.getOwnPropertyDescriptor(body, "code")?.value);
    }
  } catch {
    // Malformed envelopes are diagnosed without serializing their contents.
  }
  return projectPushRequestDiagnostic(
    operation,
    backendCode === undefined ? "malformed_body" : backendCode === 0 ? "success" : "backend_nonzero",
    { httpStatus, backendCode }
  );
}

export function describePushError(operation: PushRequestOperation, error: unknown): PushRequestDiagnostic {
  let httpStatus: number | undefined;
  try {
    let current = error;
    for (let depth = 0; depth < 4; depth++) {
      if (typeof current !== "object" || current === null) break;
      const candidate = current as { name?: unknown; cause?: unknown; response?: { statusCode?: unknown } };
      httpStatus = finiteNumber(candidate.response?.statusCode);
      if (httpStatus !== undefined) break;
      if (candidate.name !== "ApiRequestError" || candidate.cause === undefined) break;
      current = candidate.cause;
    }
  } catch {
    // Neither exception context nor response bodies enter the diagnostic.
  }
  return projectPushRequestDiagnostic(
    operation,
    httpStatus !== undefined && httpStatus !== 200 ? "http_non_200" : "transport_error",
    { httpStatus, error }
  );
}
