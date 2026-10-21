import { randomUUID } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { lamportBalance, sendIdempotent } from "./chain.js";
import { ownersForCollection } from "./core.js";
import { decryptSecret } from "./crypto.js";
import { sql, withLock } from "./db.js";
import { escrowWallet, keypairFromSecret } from "./keys.js";
import { log } from "./log.js";
import { MIN_RESERVE, equalSlices } from "./money.js";
import { collectFeeIxs, curveState } from "./pump.js";
import { isPlatformWallet } from "./wallets.js";

type CoinRow = {
  id: string;
  mint: string;
  coin_wallet: string;
  coin_secret: Buffer;
  collection_address: string | null;
  card_count: number;
  status: string;
};

type CardRow = {
  id: string;
  asset_address: string | null;
  accrued_lamports: bigint;
  status: string;
};

type Planned = {
  id: string;
  batch_id: string;
  card_id: string;
  holder_wallet: string;
  amount_lamports: bigint;
  kind: string;
  chunk: number;
};

const safeNumber = (lamports: bigint) => {
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("That amount is too large.");
  return Number(lamports);
};

export const runPayouts = async () => {
  const due = await sql<{ id: string }[]>`
    SELECT id FROM coins
    WHERE status = 'live'
      AND (last_payout_at IS NULL OR last_payout_at < now() - interval '10 minutes')
  `;
  for (const coin of due) {
    await withLock(`payout:${coin.id}`, () => payoutCoin(coin.id));
  }
};

const payoutCoin = async (id: string) => {
  const coins = await sql<CoinRow[]>`SELECT * FROM coins WHERE id = ${id}::uuid AND status = 'live'`;
  const coin = coins[0];
  if (!coin?.collection_address) return;
  const planned = await sql<Planned[]>`
    SELECT id, batch_id, card_id, holder_wallet, amount_lamports, kind, chunk
    FROM payouts WHERE coin_id = ${id}::uuid AND status = 'planned'
  `;
  if (planned.length) {
    await sendPlanned(coin, planned);
    return;
  }
  const coinKey = keypairFromSecret(decryptSecret(coin.coin_secret));
  const curve = await curveState(new PublicKey(coin.mint));
  if (curve) await sql`UPDATE coins SET graduated = ${curve.graduated} WHERE id = ${id}::uuid`;
  const before = await lamportBalance(coinKey.publicKey);
  const sweepIxs = await collectFeeIxs(coinKey.publicKey);
  let sweepSig: string | null = null;
  if (sweepIxs.length) {
    const window = Math.floor(Date.now() / 600_000);
    sweepSig = await sendIdempotent(`sweep:${id}:${window}`, async () => ({
      instructions: sweepIxs,
      signers: [coinKey],
      feePayer: coinKey.publicKey,
    }));
  }
  const after = await lamportBalance(coinKey.publicKey);
  const gained = after > before ? after - before : 0n;
  if (gained > 0n && sweepSig) {
    const existing = await sql`SELECT id FROM fee_sweeps WHERE tx_sig = ${sweepSig}`;
    if (!existing.length) {
      await sql`
        INSERT INTO fee_sweeps (id, coin_id, amount_lamports, tx_sig)
        VALUES (${randomUUID()}::uuid, ${id}::uuid, ${gained}, ${sweepSig})
      `;
    }
  }
  const cards = await sql<CardRow[]>`SELECT * FROM cards WHERE coin_id = ${id}::uuid ORDER BY card_number`;
  const assets = cards.flatMap((card) => (card.asset_address ? [card.asset_address] : []));
  const owners = await ownersForCollection(coin.collection_address, assets);
  const accrued = cards.reduce((sum, card) => sum + card.accrued_lamports, 0n);
  const balance = await lamportBalance(coinKey.publicKey);
  const distributable = balance - MIN_RESERVE - 50_000n - accrued;
  const { share } = equalSlices(distributable, coin.card_count);
  if (share <= 0n) {
    await sql`UPDATE coins SET last_payout_at = now(), tracked_lamports = ${balance} WHERE id = ${id}::uuid`;
    return;
  }
  const escrow = escrowWallet().publicKey.toBase58();
  const payments: { card: CardRow; owner: string; amount: bigint; kind: string }[] = [];
  await sql.begin(async (tx) => {
    for (const card of cards) {
      const owner = card.asset_address ? owners.get(card.asset_address) : undefined;
      const held = Boolean(owner && owner !== escrow && !(await isPlatformWallet(owner)));
      if (!held || !owner) {
        await tx`UPDATE cards SET accrued_lamports = accrued_lamports + ${share} WHERE id = ${card.id}::uuid`;
        continue;
      }
      payments.push({ card, owner, amount: share + card.accrued_lamports, kind: card.accrued_lamports > 0n ? "share_and_carried" : "share" });
    }
    if (!payments.length) return;
    const batch = randomUUID();
    await tx`INSERT INTO payout_batches (id, coin_id, status) VALUES (${batch}::uuid, ${id}::uuid, 'planned')`;
    for (const [index, payment] of payments.entries()) {
      await tx`
        INSERT INTO payouts (id, batch_id, coin_id, card_id, holder_wallet, amount_lamports, status, kind, chunk)
        VALUES (
          ${randomUUID()}::uuid, ${batch}::uuid, ${id}::uuid, ${payment.card.id}::uuid,
          ${payment.owner}, ${payment.amount}, 'planned', ${payment.kind}, ${Math.floor(index / 12)}
        )
      `;
    }
  });
  const fresh = await sql<Planned[]>`
    SELECT id, batch_id, card_id, holder_wallet, amount_lamports, kind, chunk
    FROM payouts WHERE coin_id = ${id}::uuid AND status = 'planned'
  `;
  if (fresh.length) await sendPlanned(coin, fresh);
  else {
    const end = await lamportBalance(coinKey.publicKey);
    await sql`UPDATE coins SET last_payout_at = now(), tracked_lamports = ${end} WHERE id = ${id}::uuid`;
  }
};

const sendPlanned = async (coin: CoinRow, rows: Planned[]) => {
  const coinKey = keypairFromSecret(decryptSecret(coin.coin_secret));
  const batch = rows[0].batch_id;
  const chunks = new Map<number, Planned[]>();
  for (const row of rows) {
    const group = chunks.get(row.chunk) ?? [];
    group.push(row);
    chunks.set(row.chunk, group);
  }
  for (const [chunk, group] of chunks) {
    const signature = await sendIdempotent(`payout:${batch}:${chunk}`, async () => ({
      feePayer: coinKey.publicKey,
      signers: [coinKey],
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ...group.map((row) =>
          SystemProgram.transfer({
            fromPubkey: coinKey.publicKey,
            toPubkey: new PublicKey(row.holder_wallet),
            lamports: safeNumber(row.amount_lamports),
          }),
        ),
      ],
    }));
    await sql.begin(async (tx) => {
      for (const row of group) {
        await tx`UPDATE payouts SET status = 'confirmed', tx_sig = ${signature} WHERE id = ${row.id}::uuid`;
        await tx`
          UPDATE cards
          SET paid_lamports = paid_lamports + ${row.amount_lamports},
              accrued_lamports = CASE WHEN ${row.kind} = 'share' THEN accrued_lamports ELSE 0 END
          WHERE id = ${row.card_id}::uuid
        `;
      }
      await tx`UPDATE payout_batches SET status = 'confirmed', signature = ${signature} WHERE id = ${batch}::uuid`;
    });
    log("payout confirmed", { coin: coin.mint, signature, cards: group.length });
  }
  const end = await lamportBalance(coinKey.publicKey);
  await sql`UPDATE coins SET last_payout_at = now(), tracked_lamports = ${end} WHERE id = ${coin.id}::uuid`;
};
