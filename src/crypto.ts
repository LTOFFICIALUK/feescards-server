import crypto from "node:crypto";
import { required } from "./env.js";

const key = () => {
  const raw = required("VAULT_ENC_KEY");
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error("VAULT_ENC_KEY must be 32 bytes of hex.");
  return buf;
};

export const encryptSecret = (plain: Uint8Array) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
};

export const decryptSecret = (packed: Buffer) => {
  const iv = packed.subarray(0, 12);
  const tag = packed.subarray(12, 28);
  const enc = packed.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
};
