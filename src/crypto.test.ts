import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "./crypto.js";

process.env.VAULT_ENC_KEY = crypto.randomBytes(32).toString("hex");

test("coin secrets round trip and the cipher text hides the plain bytes", () => {
  const plain = crypto.randomBytes(64);
  const packed = encryptSecret(plain);
  assert.equal(packed.includes(plain), false);
  assert.deepEqual(decryptSecret(packed), plain);
});
