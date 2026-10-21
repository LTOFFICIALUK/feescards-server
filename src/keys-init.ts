import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const file = path.join(process.cwd(), ".env");
const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
const has = (name: string) => new RegExp(`^${name}=.+`, "m").test(current);
const lines = current.trim().length ? current.replace(/\n$/, "").split("\n") : [];
const add = (name: string, value: string) => {
  if (has(name)) return;
  lines.push(`${name}=${value}`);
};

const ensureWallet = (name: string, label: string) => {
  const match = current.match(new RegExp(`^${name}=(\\S+)$`, "m"));
  if (match?.[1]) {
    console.log(`${label} ${Keypair.fromSecretKey(bs58.decode(match[1])).publicKey.toBase58()}`);
    return;
  }
  const wallet = Keypair.generate();
  add(name, bs58.encode(wallet.secretKey));
  console.log(`${label} ${wallet.publicKey.toBase58()}`);
};

ensureWallet("SEED_WALLET_SECRET", "cursor wallet");
ensureWallet("OPS_WALLET_SECRET", "ops wallet");
ensureWallet("ESCROW_WALLET_SECRET", "escrow wallet");
add("VAULT_ENC_KEY", crypto.randomBytes(32).toString("hex"));
if (!has("DATABASE_URL")) add("DATABASE_URL", "postgres://localhost:5432/feescards");
if (!has("PORT")) add("PORT", "8787");
if (!has("PUBLIC_BASE_URL")) add("PUBLIC_BASE_URL", "http://localhost:8787");
if (!has("FEES_MINT")) lines.push("FEES_MINT=");

fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
