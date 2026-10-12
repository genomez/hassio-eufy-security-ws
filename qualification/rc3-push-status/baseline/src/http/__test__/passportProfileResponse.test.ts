import {
  describePassportProfileEnvelope,
  extractPassportProfileCiphertext,
  isPassportProfileResponse,
} from "../passportProfileResponse";

describe("passport profile response compatibility", () => {
  it("extracts the canonical code-0 ciphertext", () => {
    expect(extractPassportProfileCiphertext({ code: 0, msg: "", data: "canonical-ciphertext" })).toBe(
      "canonical-ciphertext"
    );
  });

  it("extracts the exact nested code-200 ciphertext", () => {
    expect(
      extractPassportProfileCiphertext({
        code: 200,
        msg: "",
        data: { code: 200, msg: "", data: "regional-ciphertext" },
      })
    ).toBe("regional-ciphertext");
  });

  it.each([
    { code: 200, msg: "", data: "flat-regional-ciphertext" },
    { code: 200, data: "flat-regional-ciphertext" },
  ])("extracts the exact flat code-200 ciphertext", (response) => {
    expect(extractPassportProfileCiphertext(response)).toBe("flat-regional-ciphertext");
  });

  it.each([
    { code: 200, msg: "unexpected", data: "direct-code-200" },
    { code: 200, msg: "", data: "" },
    { code: 200, msg: "", data: "   " },
    { code: 200, msg: "unexpected", data: { code: 200, msg: "", data: "ciphertext" } },
    { code: 200, msg: "", data: { code: 0, msg: "", data: "ciphertext" } },
    { code: 200, msg: "", data: { code: 200, msg: "error", data: "ciphertext" } },
    { code: 200, msg: "", data: { code: 200, msg: "", data: "" } },
    { code: 401, msg: "unauthorized", data: "ciphertext" },
    null,
  ])("rejects unsupported or malformed envelopes", (response) => {
    expect(extractPassportProfileCiphertext(response)).toBeUndefined();
  });

  it("describes only envelope codes and value types", () => {
    const description = describePassportProfileEnvelope({
      code: 200,
      msg: "",
      data: { code: 200, msg: "", data: "sensitive-ciphertext" },
    });

    expect(description).toEqual({
      outerCode: 200,
      outerDataType: "object",
      innerCode: 200,
      innerDataType: "string",
    });
    expect(JSON.stringify(description)).not.toContain("sensitive-ciphertext");
  });

  it("describes the flat envelope without exposing ciphertext", () => {
    const description = describePassportProfileEnvelope({
      code: 200,
      msg: "",
      data: "sensitive-flat-ciphertext",
    });

    expect(description).toEqual({
      outerCode: 200,
      outerDataType: "string",
      innerCode: undefined,
      innerDataType: undefined,
    });
    expect(JSON.stringify(description)).not.toContain("sensitive-flat-ciphertext");
  });

  it("requires stable identity fields in decrypted profiles", () => {
    expect(isPassportProfileResponse({ user_id: "user", email: "user@example.invalid", nick_name: "User" })).toBe(true);
    expect(isPassportProfileResponse({ user_id: "", email: "user@example.invalid", nick_name: "User" })).toBe(false);
    expect(isPassportProfileResponse({ user_id: "user", email: "", nick_name: "User" })).toBe(false);
    expect(isPassportProfileResponse({ user_id: "user", email: "user@example.invalid" })).toBe(false);
  });
});
