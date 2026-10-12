import { createECDH, createHmac } from "crypto";

import {
  MEGA_PRESET_KEY,
  xSignature,
  generateKeyIdent,
  presetEncrypt,
  presetDecrypt,
  buildKeyExchange,
  finalizeKeyExchange,
  sharedKeySigningKey,
  sharedKeyToAesKey,
  megaEncryptBody,
  megaDecryptBody,
} from "../megaCrypto";

describe("megaCrypto", () => {
  describe("xSignature", () => {
    // Verified against the decompiled app (EncryptKeyFactory.encryptByHMAC):
    //   str = bodyMsg present ? `${ts}+${once}+${body}` : `${ts}+${once}`
    //   HMAC-SHA256(UTF8(key), UTF8(str)), hex lowercase.
    it("signs `ts+nonce+body` with the key as a UTF-8 string (not hex-decoded)", () => {
      const key = MEGA_PRESET_KEY;
      const ts = "1782719583";
      const nonce = "c9c1835842374199bd7abeaad8a14d50";
      const body = "somebase64body==";

      const expected = createHmac("sha256", Buffer.from(key, "utf8")).update(`${ts}+${nonce}+${body}`).digest("hex");

      expect(xSignature(key, ts, nonce, body)).toBe(expected);
    });

    it("omits the body part when no body is given (`ts+nonce`)", () => {
      const key = "abc";
      const ts = "1";
      const nonce = "ff";
      const expected = createHmac("sha256", Buffer.from(key, "utf8")).update(`${ts}+${nonce}`).digest("hex");
      expect(xSignature(key, ts, nonce)).toBe(expected);
    });

    it("uses the ASCII string of the key, NOT the hex-decoded bytes (regression guard)", () => {
      const ts = "1";
      const nonce = "2";
      const body = "x";
      const asAscii = xSignature(MEGA_PRESET_KEY, ts, nonce, body);
      const asHexBytes = createHmac("sha256", Buffer.from(MEGA_PRESET_KEY, "hex"))
        .update(`${ts}+${nonce}+${body}`)
        .digest("hex");
      expect(asAscii).not.toBe(asHexBytes);
    });

    it("is deterministic and lowercase hex of length 64", () => {
      const sig = xSignature("k", "1", "2", "b");
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
      expect(xSignature("k", "1", "2", "b")).toBe(sig);
    });
  });

  describe("generateKeyIdent", () => {
    it("returns a random 32-char lowercase hex (16 bytes)", () => {
      const a = generateKeyIdent();
      const b = generateKeyIdent();
      expect(a).toMatch(/^[0-9a-f]{32}$/);
      expect(a).not.toBe(b);
    });
  });

  describe("presetEncrypt/presetDecrypt", () => {
    it("round-trips a payload (AES-128-CBC/PKCS7, prefixed random IV)", () => {
      const plain = "04abcdef0123456789";
      const enc = presetEncrypt(plain);
      expect(presetDecrypt(enc)).toBe(plain);
    });

    it("produces a different ciphertext each time (random IV) but decrypts identically", () => {
      const plain = "hello world";
      const a = presetEncrypt(plain);
      const b = presetEncrypt(plain);
      expect(a).not.toBe(b);
      expect(presetDecrypt(a)).toBe(plain);
      expect(presetDecrypt(b)).toBe(plain);
    });

    it("output is base64 of IV(16) ++ ciphertext (length multiple of 16, >= 32)", () => {
      const blob = Buffer.from(presetEncrypt("x"), "base64");
      expect(blob.length).toBeGreaterThanOrEqual(32);
      expect(blob.length % 16).toBe(0);
    });
  });

  describe("buildKeyExchange/finalizeKeyExchange", () => {
    it("derives the SAME shared secret on both ends (ECDH P-256)", () => {
      // Simulate the server: its EC keypair; it returns its public key preset-encrypted.
      const server = createECDH("prime256v1");
      server.generateKeys();

      const { ecdh, clientPublicKey, keyIdent } = buildKeyExchange();
      const serverPubEnc = presetEncrypt(server.getPublicKey("hex"));

      const identity = finalizeKeyExchange(ecdh, serverPubEnc, keyIdent, clientPublicKey);

      // Server computes the secret with the client's public key — must match. Compare as
      // BigInt to avoid a rare flake when the shared X-coordinate's high byte is 0 and the two
      // sides hex-encode with a different number of leading zeros.
      const serverSecret = server.computeSecret(Buffer.from(clientPublicKey, "hex")).toString("hex");
      expect(BigInt(`0x${identity.sharedKey}`)).toBe(BigInt(`0x${serverSecret}`));
      expect(identity.keyIdent).toBe(keyIdent);
      expect(identity.sharedKey).toMatch(/^[0-9a-f]+$/);
    });

    it("client_public_key body decrypts back to the client's uncompressed EC point", () => {
      const { clientPublicKeyBody, clientPublicKey } = buildKeyExchange();
      expect(presetDecrypt(clientPublicKeyBody)).toBe(clientPublicKey);
      expect(clientPublicKey.startsWith("04")).toBe(true);
    });
  });

  describe("sharedKey derivations", () => {
    const sharedKey = "a379aa6966ef2eac85b65201f85213399ccb9a8692edb9eb333030c8bdfba364";

    it("signing key = first 32 hex chars of the shared key", () => {
      expect(sharedKeySigningKey(sharedKey)).toBe("a379aa6966ef2eac85b65201f8521339");
      expect(sharedKeySigningKey(sharedKey)).toHaveLength(32);
    });

    it("AES key = bytes.fromhex(sharedKey[:32]) → 16 bytes (AES-128)", () => {
      const key = sharedKeyToAesKey(sharedKey);
      expect(key).toHaveLength(16);
      expect(key.toString("hex")).toBe("a379aa6966ef2eac85b65201f8521339");
    });
  });

  describe("megaEncryptBody/megaDecryptBody", () => {
    const aesKey = sharedKeyToAesKey("a379aa6966ef2eac85b65201f85213399ccb9a8692edb9eb333030c8bdfba364");

    it("round-trips a JSON body", () => {
      const json = JSON.stringify({ email: "a@b.c", ab: "fr" });
      const enc = megaEncryptBody(json, aesKey);
      expect(megaDecryptBody(enc, aesKey)).toBe(json);
    });

    it("uses a random prefixed IV (different ciphertext, same plaintext)", () => {
      const a = megaEncryptBody("payload", aesKey);
      const b = megaEncryptBody("payload", aesKey);
      expect(a).not.toBe(b);
      expect(megaDecryptBody(a, aesKey)).toBe("payload");
    });

    it("fails to decrypt with a wrong key", () => {
      const enc = megaEncryptBody("secret", aesKey);
      const wrong = sharedKeyToAesKey("00".repeat(32));
      expect(() => megaDecryptBody(enc, wrong)).toThrow();
    });
  });
});
