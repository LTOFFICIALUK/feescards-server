import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { required } from "./env.js";

const load = (name: string) => {
  const bytes = bs58.decode(required(name));
  if (bytes.length !== 64) throw new Error(`${name} is not a Solana secret key.`);
  return Keypair.fromSecretKey(bytes);
};

export const seedWallet = () => load("SEED_WALLET_SECRET");
export const opsWallet = () => load("OPS_WALLET_SECRET");
export const escrowWallet = () => load("ESCROW_WALLET_SECRET");

export const keypairFromSecret = (secret: Uint8Array) => Keypair.fromSecretKey(secret);
