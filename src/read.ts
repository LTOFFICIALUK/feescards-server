import { PublicKey } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { rpc } from "./chain.js";
import { sql } from "./db.js";
import { optional, required } from "./env.js";
import { escrowWallet, seedWallet } from "./keys.js";
import { PACKS, rankTiers } from "./money.js";
import { curveState } from "./pump.js";

type CacheEntry<T> = { at: number; value: T };
const cache = new Map<string, CacheEntry<unknown>>();

const remember = async <T>(key: string, load: () => Promise<T>): Promise<T | null> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 45_000) return hit.value as T;
  try {
    const value = await load();
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch {
    return null;
  }
};

const dayFees = async () => {
  const sweeps = await sql<{ coin_id: string; fees: bigint }[]>`
    SELECT coin_id, COALESCE(SUM(amount_lamports), 0)::bigint AS fees
    FROM fee_sweeps
    WHERE created_at > now() - interval '24 hours'
    GROUP BY coin_id
  `;
  return new Map(sweeps.map((row) => [row.coin_id, row.fees]));
};

const vaultOf = (wallet: string) =>
  remember(`vault:${wallet}`, async () => {
    const sdk = new OnlinePumpSdk(rpc());
    const balance = await sdk.getCreatorVaultBalanceBothPrograms(new PublicKey(wallet));
    return BigInt(balance.toString());
  });

const volumeOf = (mint: string) =>
  remember(`vol:${mint}`, async () => {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { pairs?: { chainId?: string; volume?: { h24?: number } }[] };
    const pair = body.pairs?.find((item) => item.chainId === "solana" && typeof item.volume?.h24 === "number");
    return pair?.volume?.h24 ?? null;
  });

const capOf = (mint: string) => remember(`cap:${mint}`, () => curveState(new PublicKey(mint)));

type CardRow = {
  id: string;
  coin_id: string;
  name: string;
  symbol: string;
  coin_name: string;
  mint: string;
  card_number: number;
  card_count: number;
  image_path: string | null;
  asset_address: string | null;
  paid_lamports: bigint;
  accrued_lamports: bigint;
  status: string;
  is_seed: boolean;
  primary_price_lamports: bigint;
  coin_wallet: string;
  created_at: Date;
  list_price: bigint | null;
  listing_id: string | null;
  owner_wallet: string | null;
};

const cardSelect = `
  SELECT cards.id, cards.coin_id, cards.name, coins.symbol, coins.name AS coin_name, coins.mint,
         cards.card_number, coins.card_count, cards.image_path, cards.asset_address,
         cards.paid_lamports, cards.accrued_lamports, cards.status, coins.is_seed,
         cards.primary_price_lamports, coins.coin_wallet, cards.owner_wallet, coins.created_at,
         listings.price_lamports AS list_price, listings.id AS listing_id
  FROM cards
  JOIN coins ON coins.id = cards.coin_id
  LEFT JOIN listings ON listings.card_id = cards.id AND listings.status = 'active'
`;

const shape = (
  row: CardRow,
  tier: string | null,
  fees: bigint | null,
  cap: bigint | null,
  volume: number | null,
) => ({
  id: row.id,
  name: row.name,
  symbol: row.symbol,
  coinName: row.coin_name,
  mint: row.mint,
  number: row.card_number,
  count: row.card_count,
  share: `1/${row.card_count}`,
  tier,
  image: row.image_path ? `/i/${row.image_path}` : null,
  asset: row.asset_address,
  paidLamports: row.paid_lamports.toString(),
  accruedLamports: row.accrued_lamports.toString(),
  status: row.status,
  isSeed: row.is_seed,
  priceLamports: (row.status === "listed" ? row.list_price : row.status === "primary" ? row.primary_price_lamports : null)?.toString() ?? null,
  coinWallet: row.coin_wallet,
  owner: row.owner_wallet,
  dayFeesLamports: fees === null ? null : fees.toString(),
  marketCapLamports: cap === null ? null : cap.toString(),
  volumeUsd: volume,
  listingId: row.listing_id,
});

const decorate = async (rows: CardRow[]) => {
  const fees = await dayFees();
  const coinIds = [...new Set(rows.map((row) => row.coin_id))];
  const coins = coinIds.length
    ? await sql<{ id: string; coin_wallet: string; created_at: Date; last_payout_at: Date | null }[]>`
        SELECT id, coin_wallet, created_at, last_payout_at FROM coins WHERE id = ANY(${coinIds}::uuid[])
      `
    : [];
  const feeByCoin = new Map<string, bigint | null>();
  await Promise.all(
    coins.map(async (coin) => {
      const vault = await vaultOf(coin.coin_wallet);
      const swept = fees.get(coin.id) ?? 0n;
      if (vault === null) {
        feeByCoin.set(coin.id, null);
        return;
      }
      const ageMs = Date.now() - new Date(coin.created_at).getTime();
      const recent = !coin.last_payout_at || Date.now() - new Date(coin.last_payout_at).getTime() < 86_400_000 || ageMs < 86_400_000;
      feeByCoin.set(coin.id, recent ? swept + vault : swept);
    }),
  );
  const ranked = rankTiers(
    coins.map((coin) => ({ id: coin.id, fees: feeByCoin.get(coin.id) ?? 0n })),
  );
  return Promise.all(
    rows.map(async (row) => {
      const [cap, volume] = await Promise.all([capOf(row.mint), volumeOf(row.mint)]);
      const tier = ranked.get(row.coin_id) ?? null;
      const knownFees = feeByCoin.get(row.coin_id);
      return shape(row, knownFees && knownFees > 0n ? tier : null, knownFees === undefined ? null : knownFees, cap?.marketCapLamports ?? null, volume);
    }),
  );
};

export const home = async () => {
  const rows = await sql<CardRow[]>`
    ${sql.unsafe(cardSelect)}
    WHERE coins.status = 'live' AND cards.status <> 'pending'
    ORDER BY coins.created_at DESC, cards.card_number ASC
    LIMIT 12
  `;
  const payouts = await sql<{
    id: string;
    tx_sig: string;
    amount_lamports: bigint;
    holder_wallet: string;
    symbol: string;
    card_number: number;
    created_at: Date;
    mint: string;
  }[]>`
    SELECT payouts.id, payouts.tx_sig, payouts.amount_lamports, payouts.holder_wallet, coins.symbol,
           cards.card_number, payouts.created_at, coins.mint
    FROM payouts
    JOIN cards ON cards.id = payouts.card_id
    JOIN coins ON coins.id = payouts.coin_id
    WHERE payouts.status = 'confirmed' AND payouts.tx_sig IS NOT NULL
    ORDER BY payouts.created_at DESC
    LIMIT 8
  `;
  return {
    cards: await decorate(rows),
    payouts: payouts.map((row) => ({
      id: row.id,
      signature: row.tx_sig,
      lamports: row.amount_lamports.toString(),
      holder: row.holder_wallet,
      symbol: row.symbol,
      number: row.card_number,
      mint: row.mint,
      at: row.created_at,
    })),
    cursorWallet: seedWallet().publicKey.toBase58(),
  };
};

export const market = async () => {
  const rows = await sql<CardRow[]>`
    ${sql.unsafe(cardSelect)}
    WHERE cards.status IN ('primary', 'listed') AND coins.status = 'live'
    ORDER BY cards.status DESC, coins.created_at DESC, cards.card_number ASC
  `;
  return decorate(rows);
};

export const inventory = async (wallet: string) => {
  let assets: string[] = [];
  try {
    const response = await fetch(required("HELIUS_RPC_URL"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "owner",
        method: "getAssetsByOwner",
        params: { ownerAddress: wallet, page: 1, limit: 1000 },
      }),
    });
    const body = (await response.json()) as { result?: { items?: { id?: string }[] } };
    assets = (body.result?.items ?? []).flatMap((item) => (item.id ? [item.id] : []));
  } catch {
    assets = [];
  }
  const rows = await sql<CardRow[]>`
    ${sql.unsafe(cardSelect)}
    WHERE coins.status = 'live'
      AND (
        (cards.status = 'held' AND (cards.owner_wallet = ${wallet} OR cards.asset_address = ANY(${assets})))
        OR (cards.status = 'listed' AND listings.seller_wallet = ${wallet})
      )
    ORDER BY cards.card_number ASC
  `;
  const cards = await decorate(rows);
  const ids = rows.map((row) => row.id);
  const payouts = ids.length
    ? await sql<{ card_id: string; tx_sig: string; amount_lamports: bigint; created_at: Date }[]>`
        SELECT card_id, tx_sig, amount_lamports, created_at FROM payouts
        WHERE card_id = ANY(${ids}::uuid[]) AND status = 'confirmed' AND tx_sig IS NOT NULL
        ORDER BY created_at DESC
      `
    : [];
  return cards.map((card) => ({
    ...card,
    payouts: payouts
      .filter((row) => row.card_id === card.id)
      .map((row) => ({ signature: row.tx_sig, lamports: row.amount_lamports.toString(), at: row.created_at })),
  }));
};

export const coin = async (mint: string) => {
  const coins = await sql<{
    id: string;
    mint: string;
    name: string;
    symbol: string;
    description: string;
    twitter: string | null;
    image_path: string;
    coin_wallet: string;
    card_count: number;
    card_price_lamports: bigint;
    launcher_wallet: string;
    is_seed: boolean;
    graduated: boolean;
    create_sig: string | null;
    created_at: Date;
  }[]>`
    SELECT id, mint, name, symbol, description, twitter, image_path, coin_wallet, card_count,
           card_price_lamports, launcher_wallet, is_seed, graduated, create_sig, created_at
    FROM coins WHERE mint = ${mint} AND status = 'live'
  `;
  const row = coins[0];
  if (!row) return null;
  const cards = await sql<CardRow[]>`
    ${sql.unsafe(cardSelect)} WHERE cards.coin_id = ${row.id}::uuid ORDER BY cards.card_number
  `;
  const payouts = await sql<{ tx_sig: string; amount_lamports: bigint; holder_wallet: string; card_number: number; created_at: Date }[]>`
    SELECT payouts.tx_sig, payouts.amount_lamports, payouts.holder_wallet, cards.card_number, payouts.created_at
    FROM payouts JOIN cards ON cards.id = payouts.card_id
    WHERE payouts.coin_id = ${row.id}::uuid AND payouts.status = 'confirmed' AND payouts.tx_sig IS NOT NULL
    ORDER BY payouts.created_at DESC
    LIMIT 50
  `;
  const [cap, volume, vault] = await Promise.all([capOf(row.mint), volumeOf(row.mint), vaultOf(row.coin_wallet)]);
  const decorated = await decorate(cards);
  return {
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    twitter: row.twitter,
    image: `/i/${row.image_path}`,
    coinWallet: row.coin_wallet,
    cardCount: row.card_count,
    cardPriceLamports: row.card_price_lamports.toString(),
    launcher: row.launcher_wallet,
    isSeed: row.is_seed,
    graduated: row.graduated,
    createSignature: row.create_sig,
    marketCapLamports: cap?.marketCapLamports.toString() ?? null,
    volumeUsd: volume,
    vaultLamports: vault === null ? null : vault.toString(),
    dayFeesLamports: decorated[0]?.dayFeesLamports ?? null,
    cards: decorated,
    payouts: payouts.map((item) => ({
      signature: item.tx_sig,
      lamports: item.amount_lamports.toString(),
      holder: item.holder_wallet,
      number: item.card_number,
      at: item.created_at,
    })),
  };
};

export const config = () => ({
  cursorWallet: seedWallet().publicKey.toBase58(),
  escrowWallet: escrowWallet().publicKey.toBase58(),
  feesMint: optional("FEES_MINT") || null,
  packs: PACKS.map((pack) => ({ tier: pack.tier, lamports: pack.lamports.toString(), cards: pack.cards })),
});
