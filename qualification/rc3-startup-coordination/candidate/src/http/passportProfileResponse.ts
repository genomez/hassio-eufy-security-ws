import { PassportProfileResponse } from "./models";

type UnknownRecord = Record<string, unknown>;

export interface PassportProfileEnvelopeMetadata {
  outerCode?: number;
  outerDataType: string;
  innerCode?: number;
  innerDataType?: string;
}

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const valueType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const hasExpectedMessage = (value: UnknownRecord): boolean => value.msg === undefined || value.msg === "";

/**
 * Return the encrypted profile payload from a known passport-profile envelope.
 *
 * The canonical API response uses code 0 with the ciphertext directly in data.
 * Some EU responses use narrow HTTP-style wrappers with code 200 and the
 * ciphertext either directly in data or inside a second code-200 envelope.
 * Do not treat arbitrary code-200 responses as successful.
 */
export const extractPassportProfileCiphertext = (responseData: unknown): string | undefined => {
  if (!isRecord(responseData)) return undefined;

  if (responseData.code === 0 && typeof responseData.data === "string" && responseData.data.trim().length > 0) {
    return responseData.data;
  }

  if (responseData.code !== 200 || !hasExpectedMessage(responseData)) {
    return undefined;
  }

  if (typeof responseData.data === "string" && responseData.data.trim().length > 0) {
    return responseData.data;
  }

  if (!isRecord(responseData.data)) {
    return undefined;
  }

  const inner = responseData.data;
  if (
    inner.code === 200 &&
    hasExpectedMessage(inner) &&
    typeof inner.data === "string" &&
    inner.data.trim().length > 0
  ) {
    return inner.data;
  }

  return undefined;
};

/** Structural diagnostics only; never includes response payloads or messages. */
export const describePassportProfileEnvelope = (responseData: unknown): PassportProfileEnvelopeMetadata => {
  if (!isRecord(responseData)) {
    return {
      outerDataType: valueType(responseData),
    };
  }

  const inner = isRecord(responseData.data) ? responseData.data : undefined;
  return {
    outerCode: typeof responseData.code === "number" ? responseData.code : undefined,
    outerDataType: valueType(responseData.data),
    innerCode: inner && typeof inner.code === "number" ? inner.code : undefined,
    innerDataType: inner ? valueType(inner.data) : undefined,
  };
};

export const isPassportProfileResponse = (value: unknown): value is PassportProfileResponse =>
  isRecord(value) &&
  typeof value.user_id === "string" &&
  value.user_id.trim().length > 0 &&
  typeof value.email === "string" &&
  value.email.trim().length > 0 &&
  typeof value.nick_name === "string";
