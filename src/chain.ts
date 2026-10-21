import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { sql } from "./db.js";
import { required } from "./env.js";
import { log } from "./log.js";

let connection: Connection | null = null;

export const rpc = () => {
  connection ??= new Connection(required("HELIUS_RPC_URL"), "confirmed");
  return connection;
};

export const lamportBalance = async (pubkey: PublicKey) => BigInt(await rpc().getBalance(pubkey, "confirmed"));

const reasonFromLogs = (logs: string[]) => {
  const text = logs.join(" ");
  if (/insufficient lamports/i.test(text)) return "The wallet does not have enough SOL.";
  if (/Blockhash not found/i.test(text)) return "The transaction expired. Try again.";
  return "The chain rejected the transaction.";
};

export const sendIdempotent = async (
  id: string,
  build: () => Promise<{ instructions: TransactionInstruction[]; signers: Keypair[]; feePayer: PublicKey }>,
) => {
  const existing = await sql<{ signature: string | null; serialized: string | null; status: string }[]>`
    SELECT signature, serialized, status FROM chain_txs WHERE id = ${id}
  `;
  const row = existing[0];
  if (row?.signature && (row.status === "confirmed" || row.status === "sent")) {
    const settled = await settle(id, row.signature, row.serialized);
    if (settled) return settled;
  }

  const built = await build();
  const { blockhash, lastValidBlockHeight } = await rpc().getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: built.feePayer, recentBlockhash: blockhash }).add(...built.instructions);
  tx.sign(...built.signers);
  const signature = bs58.encode(tx.signature!);
  const serialized = Buffer.from(tx.serialize()).toString("base64");
  const sim = await rpc().simulateTransaction(tx);
  if (sim.value.err) {
    log("simulation failed", { id, signature, reason: reasonFromLogs(sim.value.logs ?? []) });
    throw new Error(reasonFromLogs(sim.value.logs ?? []));
  }
  await sql`
    INSERT INTO chain_txs (id, signature, serialized, status)
    VALUES (${id}, ${signature}, ${serialized}, 'sent')
    ON CONFLICT (id) DO UPDATE SET signature = EXCLUDED.signature, serialized = EXCLUDED.serialized, status = 'sent'
  `;
  await rpc().sendRawTransaction(Buffer.from(serialized, "base64"), { skipPreflight: true });
  await rpc().confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  const status = await rpc().getSignatureStatuses([signature]);
  if (status.value[0]?.err) throw new Error("The chain rejected the transaction.");
  await sql`UPDATE chain_txs SET status = 'confirmed' WHERE id = ${id}`;
  return signature;
};

const settle = async (id: string, signature: string, serialized: string | null) => {
  const status = await rpc().getSignatureStatuses([signature]);
  const value = status.value[0];
  if (value?.err) {
    await sql`UPDATE chain_txs SET status = 'failed' WHERE id = ${id}`;
    throw new Error("The chain rejected the transaction.");
  }
  if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") {
    await sql`UPDATE chain_txs SET status = 'confirmed' WHERE id = ${id}`;
    return signature;
  }
  if (!serialized) return null;
  const tx = await rpc().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (tx && !tx.meta?.err) {
    await sql`UPDATE chain_txs SET status = 'confirmed' WHERE id = ${id}`;
    return signature;
  }
  if (tx?.meta?.err) {
    await sql`UPDATE chain_txs SET status = 'failed' WHERE id = ${id}`;
    throw new Error("The chain rejected the transaction.");
  }
  try {
    await rpc().sendRawTransaction(Buffer.from(serialized, "base64"), { skipPreflight: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/expired|blockhash not found/i.test(message)) return null;
    throw new Error("The transaction could not be resent.");
  }
  const latest = await rpc().getLatestBlockhash("confirmed");
  await rpc().confirmTransaction({ signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }, "confirmed").catch(() => null);
  const again = await rpc().getSignatureStatuses([signature]);
  if (again.value[0]?.err) {
    await sql`UPDATE chain_txs SET status = 'failed' WHERE id = ${id}`;
    throw new Error("The chain rejected the transaction.");
  }
  if (again.value[0]?.confirmationStatus === "confirmed" || again.value[0]?.confirmationStatus === "finalized") {
    await sql`UPDATE chain_txs SET status = 'confirmed' WHERE id = ${id}`;
    return signature;
  }
  throw new Error("The last transaction is still waiting on chain.");
};

export const assertTransfer = async (signature: string, from: PublicKey, to: PublicKey, minLamports: bigint) => {
  const tx = await rpc().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx?.meta || tx.meta.err) throw new Error("The payment is not confirmed.");
  const meta = tx.meta;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
  const keyAt = (index: number) => keys.get(index);
  let fromIndex = -1;
  let toIndex = -1;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keyAt(i);
    if (key?.equals(from)) fromIndex = i;
    if (key?.equals(to)) toIndex = i;
  }
  if (fromIndex < 0 || toIndex < 0) throw new Error("The payment does not match this order.");
  const signed = fromIndex < tx.transaction.message.header.numRequiredSignatures;
  if (!signed) throw new Error("The payer did not sign the payment.");
  const received = BigInt(meta.postBalances[toIndex] - meta.preBalances[toIndex]);
  if (received < minLamports) throw new Error("The payment is too small.");
  return received;
};
