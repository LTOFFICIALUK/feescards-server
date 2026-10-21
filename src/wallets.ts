import { PublicKey } from "@solana/web3.js";
import { sql } from "./db.js";
import { escrowWallet, opsWallet, seedWallet } from "./keys.js";

const known = () =>
  new Set([seedWallet().publicKey.toBase58(), opsWallet().publicKey.toBase58(), escrowWallet().publicKey.toBase58()]);

export const isPlatformWallet = async (wallet: string) => {
  if (known().has(wallet)) return true;
  const rows = await sql<{ coin_wallet: string }[]>`SELECT coin_wallet FROM coins WHERE coin_wallet = ${wallet}`;
  return rows.length > 0;
};

export const assertUserWallet = async (wallet: string) => {
  try {
    const key = new PublicKey(wallet);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error("bad");
  } catch {
    throw new Error("That wallet address is not valid.");
  }
  if (await isPlatformWallet(wallet)) throw new Error("Platform wallets cannot buy or sell cards.");
};
