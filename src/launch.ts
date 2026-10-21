import { randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { assertTransfer, lamportBalance, rpc, sendIdempotent } from "./chain.js";
import { chainOwners, createCardAsset, createCardCollection } from "./core.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { sql, withLock } from "./db.js";
import { publicBase } from "./env.js";
import { escrowWallet, keypairFromSecret } from "./keys.js";
import { frameCard, normalizeImage, readImage, savePng } from "./images.js";
import { log } from "./log.js";
import { createAndBuyIxs, tokenSweepIxs } from "./pump.js";
import { quoteLaunchLamports } from "./quote.js";
import { quoteDevBuy } from "./pump.js";
import { assertUserWallet } from "./wallets.js";

type CoinRow = {
  id: string;
  mint: string;
  name: string;
  symbol: string;
  description: string;
  twitter: string | null;
  image_path: string;
  coin_wallet: string;
  coin_secret: Buffer;
  mint_secret: Buffer | null;
  collection_address: string | null;
  collection_secret: Buffer | null;
  card_count: number;
  card_price_lamports: bigint;
  dev_buy_lamports: bigint;
  fund_lamports: bigint;
  launcher_wallet: string;
  is_seed: boolean;
  status: string;
  create_sig: string | null;
  token_sig: string | null;
  funding_sig: string | null;
  error: string | null;
};

type CardRow = {
  id: string;
  card_number: number;
  asset_address: string | null;
  asset_secret: Buffer | null;
  status: string;
  name: string;
};

const loadCoin = async (id: string) => {
  const rows = await sql<CoinRow[]>`SELECT * FROM coins WHERE id = ${id}::uuid`;
  return rows[0] ?? null;
};

export const getLaunch = (id: string) => loadCoin(id);

export const prepareLaunch = async (input: {
  launcher: string;
  name: string;
  symbol: string;
  description: string;
  twitter: string | null;
  image: Buffer;
  cardCount: number;
  cardPriceLamports: bigint;
  devBuyLamports: bigint;
  isSeed?: boolean;
  fundLamports?: bigint;
}) => {
  if (!input.isSeed) await assertUserWallet(input.launcher);
  if (input.devBuyLamports > 0n) {
    const tokens = await quoteDevBuy(input.devBuyLamports);
    if (tokens.lten(0)) throw new Error("That dev buy is too small to buy the coin.");
  }
  const coin = Keypair.generate();
  const mint = Keypair.generate();
  const id = randomUUID();
  const png = await normalizeImage(input.image);
  const imagePath = `coin-${id}.png`;
  await savePng(imagePath, png);
  const fund = input.fundLamports ?? (await quoteLaunchLamports(input.cardCount, input.devBuyLamports));
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO coins (
        id, mint, name, symbol, description, twitter, image_path, metadata_uri,
        coin_wallet, coin_secret, mint_secret, card_count, card_price_lamports,
        dev_buy_lamports, fund_lamports, launcher_wallet, is_seed, status
      ) VALUES (
        ${id}::uuid, ${mint.publicKey.toBase58()}, ${input.name}, ${input.symbol}, ${input.description},
        ${input.twitter}, ${imagePath}, ${`${publicBase()}/m/coin/${mint.publicKey.toBase58()}.json`},
        ${coin.publicKey.toBase58()}, ${encryptSecret(coin.secretKey)}, ${encryptSecret(mint.secretKey)},
        ${input.cardCount}, ${input.cardPriceLamports}, ${input.devBuyLamports}, ${fund},
        ${input.launcher}, ${Boolean(input.isSeed)}, 'pending_payment'
      )
    `;
    for (let number = 1; number <= input.cardCount; number += 1) {
      await tx`
        INSERT INTO cards (id, coin_id, card_number, name, status, primary_price_lamports)
        VALUES (
          ${randomUUID()}::uuid, ${id}::uuid, ${number}, ${`${input.symbol} fee card #${number}`},
          'pending', ${input.cardPriceLamports}
        )
      `;
    }
  });
  return { id, coinWallet: coin.publicKey.toBase58(), mint: mint.publicKey.toBase58(), lamports: fund.toString() };
};

export const confirmLaunch = async (id: string, signature: string, launcher: string) => {
  const coin = await loadCoin(id);
  if (!coin) throw new Error("That launch does not exist.");
  if (coin.launcher_wallet !== launcher) throw new Error("This launch belongs to another wallet.");
  if (coin.status === "live") return { status: coin.status };
  if (!coin.funding_sig) {
    await assertTransfer(signature, new PublicKey(launcher), new PublicKey(coin.coin_wallet), coin.fund_lamports);
    await sql`
      UPDATE coins SET funding_sig = ${signature}, status = 'creating', error = NULL
      WHERE id = ${id}::uuid AND funding_sig IS NULL
    `;
  }
  void executeLaunch(id);
  return { status: "creating" };
};

export const executeLaunch = (id: string) => withLock(`launch:${id}`, () => runLaunch(id));

const keyOf = (secret: Buffer | null, label: string) => {
  if (!secret) throw new Error(`Missing ${label}.`);
  return keypairFromSecret(decryptSecret(secret));
};

const runLaunch = async (id: string) => {
  const coin = await loadCoin(id);
  if (!coin || coin.status === "live") return;
  if (coin.status !== "creating" && coin.status !== "failed") return;
  try {
    const base = publicBase();
    const uri = `${base}/m/coin/${coin.mint}.json`;
    if (uri.length > 200) throw new Error("The public address is too long for the coin metadata.");
    if (!base.startsWith("https://")) throw new Error("Set a public https address before creating a coin.");
    const probe = await fetch(uri);
    if (!probe.ok) throw new Error("The metadata address is not public yet.");
    const coinKey = keyOf(coin.coin_secret, "coin wallet");
    await ensureCreate(coin, coinKey, uri);
    await ensureTokens(coin, coinKey);
    const collection = await ensureCollection(coin, coinKey, uri);
    await ensureCards(coin, coinKey, collection);
    const balance = await lamportBalance(coinKey.publicKey);
    await sql`
      UPDATE coins SET status = 'live', error = NULL, tracked_lamports = ${balance}, mint_secret = NULL
      WHERE id = ${id}::uuid
    `;
    log("launch live", { id, mint: coin.mint });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The launch failed.";
    log("launch failed", { id, message });
    await sql`UPDATE coins SET status = 'failed', error = ${message} WHERE id = ${id}::uuid AND status <> 'live'`;
  }
};

const ensureCreate = async (coin: CoinRow, coinKey: Keypair, uri: string) => {
  if (coin.create_sig) return;
  const mintKey = keyOf(coin.mint_secret, "mint");
  const build = async (withBuy: boolean) =>
    createAndBuyIxs({
      mint: mintKey.publicKey,
      creator: coinKey.publicKey,
      name: coin.name,
      symbol: coin.symbol,
      uri,
      devBuyLamports: withBuy ? coin.dev_buy_lamports : 0n,
    });
  let signature: string;
  if (coin.dev_buy_lamports > 0n) {
    try {
      signature = await sendIdempotent(`launch:${coin.id}:create`, async () => ({
        instructions: await build(true),
        signers: [coinKey, mintKey],
        feePayer: coinKey.publicKey,
      }));
      await sql`UPDATE coins SET create_sig = ${signature}, buy_sig = ${signature} WHERE id = ${coin.id}::uuid`;
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/too large|encoded|rejected/i.test(message)) throw error;
      log("create and buy split", { id: coin.id });
    }
  }
  signature = await sendIdempotent(`launch:${coin.id}:create-only`, async () => ({
    instructions: await build(false),
    signers: [coinKey, mintKey],
    feePayer: coinKey.publicKey,
  }));
  await sql`UPDATE coins SET create_sig = ${signature} WHERE id = ${coin.id}::uuid`;
  if (coin.dev_buy_lamports > 0n) {
    const buySig = await sendIdempotent(`launch:${coin.id}:buy`, async () => ({
      instructions: await (await import("./pump.js")).buyIxs({
        mint: new PublicKey(coin.mint),
        user: coinKey.publicKey,
        devBuyLamports: coin.dev_buy_lamports,
      }),
      signers: [coinKey],
      feePayer: coinKey.publicKey,
    }));
    await sql`UPDATE coins SET buy_sig = ${buySig} WHERE id = ${coin.id}::uuid`;
  }
};

const ensureTokens = async (coin: CoinRow, coinKey: Keypair) => {
  if (coin.dev_buy_lamports <= 0n || coin.token_sig) return;
  const sweep = await tokenSweepIxs(new PublicKey(coin.mint), coinKey.publicKey, new PublicKey(coin.launcher_wallet));
  if (!sweep) return;
  const signature = await sendIdempotent(`launch:${coin.id}:tokens`, async () => ({
    instructions: sweep.instructions,
    signers: [coinKey],
    feePayer: coinKey.publicKey,
  }));
  await sql`UPDATE coins SET token_sig = ${signature} WHERE id = ${coin.id}::uuid`;
};

const ensureCollection = async (coin: CoinRow, coinKey: Keypair, uri: string) => {
  if (coin.collection_address) {
    const info = await rpc().getAccountInfo(new PublicKey(coin.collection_address));
    if (info) {
      await sql`UPDATE coins SET collection_secret = NULL WHERE id = ${coin.id}::uuid`;
      return coin.collection_address;
    }
  }
  const collectionKey = coin.collection_secret ? keyOf(coin.collection_secret, "collection") : Keypair.generate();
  if (coin.collection_address && !coin.collection_secret && !collectionKey.publicKey.toBase58().includes(coin.collection_address)) {
    throw new Error("The collection key is missing.");
  }
  if (!coin.collection_address) {
    await sql`
      UPDATE coins SET collection_address = ${collectionKey.publicKey.toBase58()}, collection_secret = ${encryptSecret(collectionKey.secretKey)}
      WHERE id = ${coin.id}::uuid
    `;
  }
  await createCardCollection(coinKey, collectionKey, `${coin.symbol} fee cards`, uri);
  await sql`UPDATE coins SET collection_secret = NULL WHERE id = ${coin.id}::uuid`;
  return collectionKey.publicKey.toBase58();
};

const ensureCards = async (coin: CoinRow, coinKey: Keypair, collection: string) => {
  const cards = await sql<CardRow[]>`SELECT * FROM cards WHERE coin_id = ${coin.id}::uuid ORDER BY card_number`;
  const coinPng = await readImage(coin.image_path);
  const escrow = escrowWallet().publicKey.toBase58();
  for (const card of cards) {
    const assetKey = card.asset_secret ? keyOf(card.asset_secret, "card") : Keypair.generate();
    const asset = card.asset_address ?? assetKey.publicKey.toBase58();
    const imagePath = `card-${card.id}.png`;
    const metadata = `${publicBase()}/m/card/${card.id}.json`;
    if (!card.asset_address) {
      await savePng(imagePath, await frameCard(coinPng));
      await sql`
        UPDATE cards
        SET asset_address = ${asset}, asset_secret = ${encryptSecret(assetKey.secretKey)},
            image_path = ${imagePath}, metadata_uri = ${metadata}
        WHERE id = ${card.id}::uuid
      `;
    }
    const owners = await chainOwners([asset]);
    if (owners.get(asset) !== escrow) {
      if (card.asset_address && !card.asset_secret && assetKey.publicKey.toBase58() !== asset) {
        throw new Error("The card asset is missing on chain.");
      }
      await createCardAsset({
        payer: coinKey,
        asset: assetKey,
        collection,
        owner: escrow,
        name: card.name,
        uri: metadata,
        attributes: [
          { key: "Coin mint", value: coin.mint },
          { key: "Coin wallet", value: coin.coin_wallet },
          { key: "Fee share", value: `1/${coin.card_count}` },
          { key: "Card number", value: String(card.card_number) },
        ],
      });
    }
    await sql`
      UPDATE cards SET status = 'primary', owner_wallet = ${escrow}, asset_secret = NULL
      WHERE id = ${card.id}::uuid
    `;
  }
};
