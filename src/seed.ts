import fs from "node:fs";
import path from "node:path";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { lamportBalance, sendIdempotent } from "./chain.js";
import { sql, withLock } from "./db.js";
import { publicBase } from "./env.js";
import { seedWallet } from "./keys.js";
import { executeLaunch, getLaunch, prepareLaunch } from "./launch.js";
import { log } from "./log.js";
import { quoteLaunchLamports } from "./quote.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const descriptions: Record<string, string> = {
  feescat: "A cat that watches the fees.",
  paydaypup: "A pup that waits for payday.",
  rentfrog: "A frog that counts the rent.",
  royaltyrat: "A rat that keeps the royalty.",
  tiphamster: "A hamster that holds the tip.",
};

export const armSeed = async () => {
  const wallet = seedWallet();
  const address = wallet.publicKey.toBase58();
  const state = await sql<{ go_live_at: Date | null }[]>`SELECT go_live_at FROM seed_state WHERE id = 1`;
  if (state[0]?.go_live_at) {
    log("seed already armed", { cursor: address, goLive: state[0].go_live_at.toISOString() });
    return true;
  }
  const balance = await lamportBalance(wallet.publicKey);
  if (balance < 350_000_000n) {
    log("seed waiting for SOL", { cursor: address, lamports: balance.toString() });
    console.log(`cursor wallet ${address}`);
    console.log("Send 0.4 SOL to that address, then run npm run seed:start again.");
    return false;
  }
  if (!publicBase().startsWith("https://")) {
    console.log(`cursor wallet ${address}`);
    console.log("Set PUBLIC_BASE_URL to the public https address before arming the seed.");
    return false;
  }
  await sql`UPDATE seed_state SET go_live_at = now(), cursor_wallet = ${address} WHERE id = 1 AND go_live_at IS NULL`;
  log("seed armed", { cursor: address });
  console.log(`cursor wallet ${address}`);
  return true;
};

const fundFor = async (devBuy: bigint) => {
  const quote = await quoteLaunchLamports(10, devBuy);
  const first = await sql<{ fund_lamports: bigint; tracked_lamports: bigint; dev_buy_lamports: bigint }[]>`
    SELECT fund_lamports, tracked_lamports, dev_buy_lamports
    FROM coins WHERE is_seed = TRUE AND status = 'live'
    ORDER BY created_at ASC LIMIT 1
  `;
  const row = first[0];
  if (!row || row.tracked_lamports <= 0n) return quote;
  const consumed = row.fund_lamports - row.tracked_lamports - row.dev_buy_lamports;
  if (consumed < 5_000_000n) return quote;
  return consumed + devBuy + 1_000_000n;
};

const launchOne = async (slug: string) => {
  const items = await sql<{
    slug: string;
    name: string;
    symbol: string;
    image_file: string;
    status: string;
    coin_id: string | null;
  }[]>`SELECT slug, name, symbol, image_file, status, coin_id FROM seed_launches WHERE slug = ${slug}`;
  const item = items[0];
  if (!item || item.status !== "pending") return;
  if (item.coin_id) {
    const existing = await getLaunch(item.coin_id);
    if (existing?.status === "live") {
      await sql`UPDATE seed_launches SET status = 'launched', updated_at = now() WHERE slug = ${slug}`;
      return;
    }
    if (existing && existing.status !== "pending_payment") {
      await executeLaunch(item.coin_id);
      const after = await getLaunch(item.coin_id);
      if (after?.status === "live") await sql`UPDATE seed_launches SET status = 'launched', note = NULL, updated_at = now() WHERE slug = ${slug}`;
      return;
    }
  }
  const pending = await sql<{ slug: string }[]>`SELECT slug FROM seed_launches WHERE status = 'pending'`;
  const wallet = seedWallet();
  const balance = await lamportBalance(wallet.publicKey);
  const bare = await fundFor(0n);
  const keep = bare * BigInt(Math.max(pending.length - 1, 0)) + 3_000_000n;
  const room = balance - keep - bare;
  if (room < 0n) {
    await sql`UPDATE seed_launches SET status = 'skipped', note = 'balance too low', updated_at = now() WHERE slug = ${slug}`;
    log("seed skipped", { slug, lamports: balance.toString() });
    return;
  }
  const devBuy = room > 8_000_000n ? 5_000_000n : room > 2_000_000n ? 1_000_000n : 0n;
  const fund = await fundFor(devBuy);
  if (balance < fund + keep) {
    await sql`UPDATE seed_launches SET status = 'skipped', note = 'balance too low', updated_at = now() WHERE slug = ${slug}`;
    log("seed skipped", { slug, lamports: balance.toString() });
    return;
  }
  const image = fs.readFileSync(path.join(process.cwd(), "seeds", item.image_file));
  const prepared = await prepareLaunch({
    launcher: wallet.publicKey.toBase58(),
    name: item.name,
    symbol: item.symbol,
    description: descriptions[slug] ?? item.name,
    twitter: "https://x.com/feesdotcards",
    image,
    cardCount: 10,
    cardPriceLamports: 40_000_000n,
    devBuyLamports: devBuy,
    isSeed: true,
    fundLamports: fund,
  });
  await sql`UPDATE seed_launches SET coin_id = ${prepared.id}::uuid, updated_at = now() WHERE slug = ${slug}`;
  const signature = await sendIdempotent(`seed-fund:${prepared.id}`, async () => ({
    feePayer: wallet.publicKey,
    signers: [wallet],
    instructions: [
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: new PublicKey(prepared.coinWallet),
        lamports: Number(BigInt(prepared.lamports)),
      }),
    ],
  }));
  await sql`UPDATE coins SET funding_sig = ${signature}, status = 'creating' WHERE id = ${prepared.id}::uuid`;
  await executeLaunch(prepared.id);
  const done = await getLaunch(prepared.id);
  if (done?.status === "live") {
    await sql`UPDATE seed_launches SET status = 'launched', note = NULL, updated_at = now() WHERE slug = ${slug}`;
    log("seed launched", { slug, mint: prepared.mint });
    return;
  }
  log("seed launch incomplete", { slug, status: done?.status ?? "missing" });
};

export const runSeed = async () => {
  const armed = await sql<{ go_live_at: Date | null }[]>`SELECT go_live_at FROM seed_state WHERE id = 1`;
  if (!armed[0]?.go_live_at) return;
  const locked = await withLock("feescards-seed", async () => {
    for (;;) {
      const state = await sql<{ go_live_at: Date }[]>`SELECT go_live_at FROM seed_state WHERE id = 1`;
      const goLive = new Date(state[0].go_live_at).getTime();
      const items = await sql<{ slug: string; offset_seconds: number; status: string }[]>`
        SELECT slug, offset_seconds, status FROM seed_launches ORDER BY offset_seconds
      `;
      if (items.every((item) => item.status !== "pending")) {
        log("seed finished", {});
        return;
      }
      const due = items.filter((item) => item.status === "pending" && goLive + item.offset_seconds * 1000 <= Date.now());
      for (const item of due) await launchOne(item.slug);
      await sleep(5_000);
    }
  });
  if (locked === null) log("seed runner already active", {});
};
