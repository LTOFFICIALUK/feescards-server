import { randomUUID, randomBytes } from "node:crypto";
import { ComputeBudgetProgram, PublicKey, SystemProgram } from "@solana/web3.js";
import { assertTransfer, lamportBalance, rpc, sendIdempotent } from "./chain.js";
import { chainOwners, listingTransaction, transferAsset } from "./core.js";
import { decryptSecret } from "./crypto.js";
import { sql } from "./db.js";
import { escrowWallet, keypairFromSecret, opsWallet } from "./keys.js";
import { log } from "./log.js";
import { MARKET_FEE_BPS, MIN_RESERVE, PACKS, PRIMARY_FEE_BPS, pickPack, rankTiers, splitFee, type PackTier } from "./money.js";
import { assertUserWallet } from "./wallets.js";

const safeNumber = (lamports: bigint) => {
  if (lamports > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("That amount is too large.");
  return Number(lamports);
};

const payMoves = async (id: string, from: "escrow" | "coin", secret: Buffer | null, moves: { to: string; lamports: bigint }[]) => {
  const usable = moves.filter((move) => move.lamports > 0n);
  if (!usable.length) return null;
  const key = from === "escrow" ? escrowWallet() : keypairFromSecret(secret!);
  return sendIdempotent(id, async () => ({
    feePayer: key.publicKey,
    signers: [key],
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ...usable.map((move) =>
        SystemProgram.transfer({
          fromPubkey: key.publicKey,
          toPubkey: new PublicKey(move.to),
          lamports: safeNumber(move.lamports),
        }),
      ),
    ],
  }));
};

const giveAsset = async (asset: string, collection: string, owner: string) => {
  const signature = await transferAsset(escrowWallet(), asset, collection, owner);
  if (signature) return signature;
  const recent = await rpc().getSignaturesForAddress(new PublicKey(asset), { limit: 1 });
  return recent[0]?.signature ?? null;
};

const payCarried = async (saleId: string, cardId: string, buyer: string) => {
  const rows = await sql<{ accrued_lamports: bigint; coin_secret: Buffer; coin_id: string }[]>`
    SELECT cards.accrued_lamports, coins.coin_secret, coins.id AS coin_id
    FROM cards JOIN coins ON coins.id = cards.coin_id
    WHERE cards.id = ${cardId}::uuid
  `;
  const row = rows[0];
  if (!row || row.accrued_lamports <= 0n) return null;
  const coinKey = keypairFromSecret(decryptSecret(row.coin_secret));
  const balance = await lamportBalance(coinKey.publicKey);
  const room = balance > MIN_RESERVE ? balance - MIN_RESERVE : 0n;
  const amount = room < row.accrued_lamports ? room : row.accrued_lamports;
  if (amount <= 0n) return null;
  const signature = await payMoves(`carried:${saleId}`, "coin", row.coin_secret, [{ to: buyer, lamports: amount }]);
  if (!signature) return null;
  const prior = await sql`SELECT id FROM payouts WHERE tx_sig = ${signature} AND kind = 'carried' AND card_id = ${cardId}::uuid`;
  if (!prior.length) {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO payouts (id, coin_id, card_id, holder_wallet, amount_lamports, tx_sig, status, kind)
        VALUES (${randomUUID()}::uuid, ${row.coin_id}::uuid, ${cardId}::uuid, ${buyer}, ${amount}, ${signature}, 'confirmed', 'carried')
      `;
      await tx`
        UPDATE cards
        SET accrued_lamports = GREATEST(accrued_lamports - ${amount}, 0),
            paid_lamports = paid_lamports + ${amount}
        WHERE id = ${cardId}::uuid
      `;
    });
  }
  return signature;
};

export const preparePack = async (buyer: string, tier: PackTier) => {
  await assertUserWallet(buyer);
  const pack = PACKS.find((item) => item.tier === tier);
  if (!pack) throw new Error("That pack does not exist.");
  const available = await sql<{ id: string; price: bigint }[]>`
    SELECT id, primary_price_lamports AS price FROM cards
    WHERE status = 'primary' AND (reserved_until IS NULL OR reserved_until < now())
  `;
  const seed = randomBytes(16).toString("hex");
  const picked = pickPack(available, pack.lamports, seed);
  if (!picked) throw new Error("No five cards fit this pack yet.");
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO packs (id, buyer_wallet, tier, price_lamports, seed, status)
      VALUES (${id}::uuid, ${buyer}, ${tier}, ${pack.lamports}, ${seed}, 'reserved')
    `;
    for (const [index, card] of picked.entries()) {
      const locked = await tx`
        UPDATE cards SET status = 'reserved', reserved_pack_id = ${id}::uuid, reserved_until = now() + interval '10 minutes'
        WHERE id = ${card.id}::uuid AND status = 'primary'
        RETURNING id
      `;
      if (!locked.length) throw new Error("Those cards were just taken. Try the pack again.");
      await tx`
        INSERT INTO pack_cards (pack_id, card_id, position) VALUES (${id}::uuid, ${card.id}::uuid, ${index})
      `;
    }
  });
  return { id, lamports: pack.lamports.toString(), escrow: escrowWallet().publicKey.toBase58() };
};

export const confirmPack = async (id: string, buyer: string, signature: string) => {
  await assertUserWallet(buyer);
  const packs = await sql<{ id: string; buyer_wallet: string; price_lamports: bigint; status: string; payment_sig: string | null }[]>`
    SELECT id, buyer_wallet, price_lamports, status, payment_sig FROM packs WHERE id = ${id}::uuid
  `;
  const pack = packs[0];
  if (!pack) throw new Error("That pack does not exist.");
  if (pack.buyer_wallet !== buyer) throw new Error("This pack belongs to another wallet.");
  if (pack.status === "done") return packView(id);
  if (!pack.payment_sig) {
    await assertTransfer(signature, new PublicKey(buyer), escrowWallet().publicKey, pack.price_lamports);
    await sql`UPDATE packs SET payment_sig = ${signature}, status = 'fulfilling' WHERE id = ${id}::uuid AND payment_sig IS NULL`;
  }
  await fulfillPack(id, buyer);
  return packView(id);
};

const fulfillPack = async (id: string, buyer: string) => {
  const cards = await sql<{
    card_id: string;
    position: number;
    asset_address: string;
    collection_address: string;
    launcher_wallet: string;
    primary_price_lamports: bigint;
    transfer_sig: string | null;
    launcher_sig: string | null;
  }[]>`
    SELECT pack_cards.card_id, pack_cards.position, cards.asset_address, coins.collection_address,
           coins.launcher_wallet, cards.primary_price_lamports, pack_cards.transfer_sig, pack_cards.launcher_sig
    FROM pack_cards
    JOIN cards ON cards.id = pack_cards.card_id
    JOIN coins ON coins.id = cards.coin_id
    WHERE pack_cards.pack_id = ${id}::uuid
    ORDER BY pack_cards.position
  `;
  const launcherPaid = cards.reduce((sum, card) => sum + splitFee(card.primary_price_lamports, PRIMARY_FEE_BPS).seller, 0n);
  for (const card of cards) {
    if (!card.transfer_sig) {
      const signature = await giveAsset(card.asset_address, card.collection_address, buyer);
      await sql`
        UPDATE pack_cards SET transfer_sig = ${signature}
        WHERE pack_id = ${id}::uuid AND card_id = ${card.card_id}::uuid
      `;
      await sql`
        UPDATE cards SET status = 'held', owner_wallet = ${buyer}, reserved_pack_id = NULL, reserved_until = NULL
        WHERE id = ${card.card_id}::uuid
      `;
    }
    if (!card.launcher_sig) {
      const split = splitFee(card.primary_price_lamports, PRIMARY_FEE_BPS);
      const signature = await payMoves(`pack:${id}:launcher:${card.card_id}`, "escrow", null, [
        { to: card.launcher_wallet, lamports: split.seller },
      ]);
      await sql`
        UPDATE pack_cards SET launcher_sig = ${signature}
        WHERE pack_id = ${id}::uuid AND card_id = ${card.card_id}::uuid
      `;
    }
    await payCarried(`pack:${id}:${card.card_id}`, card.card_id, buyer);
  }
  const packRows = await sql<{ price_lamports: bigint }[]>`SELECT price_lamports FROM packs WHERE id = ${id}::uuid`;
  const platform = packRows[0].price_lamports - launcherPaid;
  await payMoves(`pack:${id}:platform`, "escrow", null, [{ to: opsWallet().publicKey.toBase58(), lamports: platform > 0n ? platform : 0n }]);
  await sql`UPDATE packs SET status = 'done', error = NULL WHERE id = ${id}::uuid`;
  log("pack done", { id, buyer });
};

const packView = async (id: string) => {
  const cards = await sql<{
    id: string;
    coin_id: string;
    name: string;
    symbol: string;
    card_number: number;
    card_count: number;
    image_path: string | null;
    asset_address: string | null;
    position: number;
  }[]>`
    SELECT cards.id, cards.coin_id, cards.name, coins.symbol, cards.card_number, coins.card_count, cards.image_path,
           cards.asset_address, pack_cards.position
    FROM pack_cards
    JOIN cards ON cards.id = pack_cards.card_id
    JOIN coins ON coins.id = cards.coin_id
    WHERE pack_cards.pack_id = ${id}::uuid
    ORDER BY pack_cards.position
  `;
  const fees = await sql<{ coin_id: string; fees: bigint }[]>`
    SELECT coin_id, COALESCE(SUM(amount_lamports), 0)::bigint AS fees
    FROM fee_sweeps
    WHERE created_at > now() - interval '24 hours'
    GROUP BY coin_id
  `;
  const ranked = rankTiers(fees.map((row) => ({ id: row.coin_id, fees: row.fees })));
  return {
    id,
    status: "done",
    cards: cards.map((card) => ({
      id: card.id,
      name: card.name,
      symbol: card.symbol,
      number: card.card_number,
      share: `1/${card.card_count}`,
      tier: ranked.get(card.coin_id) ?? null,
      image: card.image_path ? `/i/${card.image_path}` : null,
      asset: card.asset_address,
    })),
  };
};

export const preparePrimary = async (cardId: string, buyer: string) => {
  await assertUserWallet(buyer);
  const cards = await sql<{ id: string; status: string; primary_price_lamports: bigint }[]>`
    SELECT id, status, primary_price_lamports FROM cards WHERE id = ${cardId}::uuid
  `;
  const card = cards[0];
  if (!card || card.status !== "primary") throw new Error("That card is not for sale.");
  return { cardId, lamports: card.primary_price_lamports.toString(), escrow: escrowWallet().publicKey.toBase58() };
};

export const confirmPrimary = async (cardId: string, buyer: string, signature: string) => {
  await assertUserWallet(buyer);
  const cards = await sql<{
    id: string;
    status: string;
    primary_price_lamports: bigint;
    asset_address: string;
    collection_address: string;
    launcher_wallet: string;
  }[]>`
    SELECT cards.id, cards.status, cards.primary_price_lamports, cards.asset_address, coins.collection_address, coins.launcher_wallet
    FROM cards JOIN coins ON coins.id = cards.coin_id
    WHERE cards.id = ${cardId}::uuid
  `;
  const card = cards[0];
  if (!card?.asset_address) throw new Error("That card is not for sale.");
  const existing = await sql<{ id: string; status: string }[]>`
    SELECT id, status FROM primary_sales WHERE payment_sig = ${signature}
  `;
  if (existing[0]?.status === "done") return { status: "done" };
  if (card.status !== "primary" && !existing.length) throw new Error("That card is not for sale.");
  const split = splitFee(card.primary_price_lamports, PRIMARY_FEE_BPS);
  let saleId = existing[0]?.id;
  if (!saleId) {
    await assertTransfer(signature, new PublicKey(buyer), escrowWallet().publicKey, card.primary_price_lamports);
    saleId = randomUUID();
    await sql`
      INSERT INTO primary_sales (id, card_id, buyer_wallet, price_lamports, launcher_lamports, platform_lamports, payment_sig, status)
      VALUES (${saleId}::uuid, ${cardId}::uuid, ${buyer}, ${card.primary_price_lamports}, ${split.seller}, ${split.platform}, ${signature}, 'paying')
    `;
  }
  const transferSig = await giveAsset(card.asset_address, card.collection_address, buyer);
  const paySig = await payMoves(`primary:${saleId}:pay`, "escrow", null, [
    { to: card.launcher_wallet, lamports: split.seller },
    { to: opsWallet().publicKey.toBase58(), lamports: split.platform },
  ]);
  await sql`
    UPDATE cards SET status = 'held', owner_wallet = ${buyer}, reserved_pack_id = NULL, reserved_until = NULL
    WHERE id = ${cardId}::uuid
  `;
  const carried = await payCarried(saleId, cardId, buyer);
  await sql`
    UPDATE primary_sales SET status = 'done', transfer_sig = ${transferSig}, pay_sig = ${paySig}, carried_sig = ${carried}
    WHERE id = ${saleId}::uuid
  `;
  return { status: "done", transferSig, paySig, carried };
};

export const prepareListing = async (cardId: string, seller: string, priceLamports: bigint) => {
  await assertUserWallet(seller);
  if (priceLamports <= 0n) throw new Error("Enter a price.");
  const cards = await sql<{ id: string; status: string; asset_address: string; collection_address: string; owner_wallet: string | null }[]>`
    SELECT cards.id, cards.status, cards.asset_address, coins.collection_address, cards.owner_wallet
    FROM cards JOIN coins ON coins.id = cards.coin_id
    WHERE cards.id = ${cardId}::uuid
  `;
  const card = cards[0];
  if (!card?.asset_address || card.status !== "held") throw new Error("That card cannot be listed.");
  const owners = await chainOwners([card.asset_address]);
  if (owners.get(card.asset_address) !== seller) throw new Error("That card is not in this wallet.");
  const id = randomUUID();
  await sql`
    INSERT INTO listings (id, card_id, seller_wallet, price_lamports, status)
    VALUES (${id}::uuid, ${cardId}::uuid, ${seller}, ${priceLamports}, 'pending_escrow')
  `;
  const transaction = await listingTransaction({
    seller,
    asset: card.asset_address,
    collection: card.collection_address,
  });
  return { id, transaction };
};

export const confirmListing = async (id: string, seller: string, signature: string) => {
  const listings = await sql<{ id: string; card_id: string; seller_wallet: string; status: string }[]>`
    SELECT id, card_id, seller_wallet, status FROM listings WHERE id = ${id}::uuid
  `;
  const listing = listings[0];
  if (!listing || listing.seller_wallet !== seller) throw new Error("That listing does not exist.");
  if (listing.status === "active") return { status: "active" };
  const tx = await rpc().getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!tx || tx.meta?.err) throw new Error("The listing transaction is not confirmed.");
  const cards = await sql<{ asset_address: string }[]>`SELECT asset_address FROM cards WHERE id = ${listing.card_id}::uuid`;
  const owners = await chainOwners([cards[0].asset_address]);
  if (owners.get(cards[0].asset_address) !== escrowWallet().publicKey.toBase58()) {
    throw new Error("The card is not in escrow yet.");
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE listings SET status = 'active', escrow_sig = ${signature} WHERE id = ${id}::uuid`;
    await tx`UPDATE cards SET status = 'listed', owner_wallet = ${escrowWallet().publicKey.toBase58()} WHERE id = ${listing.card_id}::uuid`;
  });
  return { status: "active" };
};

export const prepareListingBuy = async (id: string, buyer: string) => {
  await assertUserWallet(buyer);
  const listings = await sql<{ id: string; seller_wallet: string; price_lamports: bigint; status: string }[]>`
    SELECT id, seller_wallet, price_lamports, status FROM listings WHERE id = ${id}::uuid
  `;
  const listing = listings[0];
  if (!listing || listing.status !== "active") throw new Error("That listing is not active.");
  if (listing.seller_wallet === buyer) throw new Error("You already hold this card.");
  return { id, lamports: listing.price_lamports.toString(), escrow: escrowWallet().publicKey.toBase58() };
};

export const confirmListingBuy = async (id: string, buyer: string, signature: string) => {
  await assertUserWallet(buyer);
  const listings = await sql<{
    id: string;
    card_id: string;
    seller_wallet: string;
    price_lamports: bigint;
    status: string;
    asset_address: string;
    collection_address: string;
  }[]>`
    SELECT listings.id, listings.card_id, listings.seller_wallet, listings.price_lamports, listings.status,
           cards.asset_address, coins.collection_address
    FROM listings
    JOIN cards ON cards.id = listings.card_id
    JOIN coins ON coins.id = cards.coin_id
    WHERE listings.id = ${id}::uuid
  `;
  const listing = listings[0];
  if (!listing) throw new Error("That listing does not exist.");
  if (listing.status === "sold") return { status: "sold" };
  if (listing.status !== "active") throw new Error("That listing is not active.");
  await assertTransfer(signature, new PublicKey(buyer), escrowWallet().publicKey, listing.price_lamports);
  const split = splitFee(listing.price_lamports, MARKET_FEE_BPS);
  const transferSig = await giveAsset(listing.asset_address, listing.collection_address, buyer);
  const paySig = await payMoves(`listing:${id}:pay`, "escrow", null, [
    { to: listing.seller_wallet, lamports: split.seller },
    { to: opsWallet().publicKey.toBase58(), lamports: split.platform },
  ]);
  await sql`
    UPDATE cards SET status = 'held', owner_wallet = ${buyer} WHERE id = ${listing.card_id}::uuid
  `;
  const carried = await payCarried(id, listing.card_id, buyer);
  await sql`
    UPDATE listings SET status = 'sold', payment_sig = ${signature}, transfer_sig = ${transferSig}, pay_sig = ${paySig}, carried_sig = ${carried}
    WHERE id = ${id}::uuid
  `;
  return { status: "sold" };
};

export const cancelListing = async (id: string, seller: string) => {
  const listings = await sql<{
    id: string;
    card_id: string;
    seller_wallet: string;
    status: string;
    asset_address: string;
    collection_address: string;
    accrued_lamports: bigint;
  }[]>`
    SELECT listings.id, listings.card_id, listings.seller_wallet, listings.status,
           cards.asset_address, coins.collection_address, cards.accrued_lamports
    FROM listings
    JOIN cards ON cards.id = listings.card_id
    JOIN coins ON coins.id = cards.coin_id
    WHERE listings.id = ${id}::uuid
  `;
  const listing = listings[0];
  if (!listing || listing.seller_wallet !== seller) throw new Error("That listing does not exist.");
  if (listing.status !== "active" && listing.status !== "pending_escrow") throw new Error("That listing is closed.");
  if (listing.status === "pending_escrow") {
    await sql`UPDATE listings SET status = 'cancelled' WHERE id = ${id}::uuid`;
    return { status: "cancelled" };
  }
  const signature = await giveAsset(listing.asset_address, listing.collection_address, seller);
  await sql.begin(async (tx) => {
    await tx`UPDATE listings SET status = 'cancelled', transfer_sig = ${signature} WHERE id = ${id}::uuid`;
    await tx`UPDATE cards SET status = 'held', owner_wallet = ${seller} WHERE id = ${listing.card_id}::uuid`;
  });
  await payCarried(`cancel:${id}`, listing.card_id, seller);
  return { status: "cancelled" };
};

export const expirePacks = async () => {
  const expired = await sql<{ id: string }[]>`
    UPDATE packs SET status = 'expired'
    WHERE status = 'reserved' AND created_at < now() - interval '10 minutes' AND payment_sig IS NULL
    RETURNING id
  `;
  for (const pack of expired) {
    await sql`
      UPDATE cards SET status = 'primary', reserved_pack_id = NULL, reserved_until = NULL
      WHERE reserved_pack_id = ${pack.id}::uuid AND status = 'reserved'
    `;
  }
};
