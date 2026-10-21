import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { z } from "zod";
import { dataDir, publicBase } from "./env.js";
import { sql } from "./db.js";
import { confirmLaunch, getLaunch, prepareLaunch } from "./launch.js";
import { solToLamports } from "./money.js";
import { coin, config, home, inventory, market } from "./read.js";
import {
  cancelListing,
  confirmListing,
  confirmListingBuy,
  confirmPack,
  confirmPrimary,
  prepareListing,
  prepareListingBuy,
  preparePack,
  preparePrimary,
} from "./trade.js";

const app = express();
app.set("trust proxy", 1);
app.use(cors({ origin: true }));
app.use(express.json({ limit: "6mb" }));

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: "Check the form and try again." });
        return;
      }
      const message = error instanceof Error ? error.message : "Something went wrong.";
      const safe = message.length < 200 ? message : "Something went wrong.";
      res.status(400).json({ error: safe });
    });
  };

const twitterOk = (value: string | null | undefined) => {
  if (!value) return null;
  if (!/^https:\/\/(x|twitter)\.com\/[A-Za-z0-9_]{1,30}\/?$/.test(value)) {
    throw new Error("Use a full X link, like https://x.com/name");
  }
  return value;
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/v1/config", wrap(async (_req, res) => {
  res.json(config());
}));

app.get("/v1/home", wrap(async (_req, res) => {
  res.json(await home());
}));

app.get("/v1/market", wrap(async (_req, res) => {
  res.json(await market());
}));

app.get("/v1/inventory/:wallet", wrap(async (req, res) => {
  res.json(await inventory(req.params.wallet));
}));

app.get("/v1/coins/:mint", wrap(async (req, res) => {
  const row = await coin(req.params.mint);
  if (!row) {
    res.status(404).json({ error: "That coin is not live." });
    return;
  }
  res.json(row);
}));

app.get("/v1/launches/:id", wrap(async (req, res) => {
  const row = await getLaunch(req.params.id);
  if (!row) {
    res.status(404).json({ error: "That launch does not exist." });
    return;
  }
  res.json({
    id: row.id,
    status: row.status,
    mint: row.mint,
    symbol: row.symbol,
    error: row.error,
    createSignature: row.create_sig,
  });
}));

const launchBody = z.object({
  launcher: z.string().min(32).max(44),
  name: z.string().trim().min(1).max(32),
  symbol: z.string().trim().min(1).max(13),
  description: z.string().trim().min(1).max(400),
  twitter: z.string().trim().max(80).optional().nullable(),
  imageBase64: z.string().min(16),
  cardCount: z.union([z.literal(10), z.literal(25), z.literal(50)]),
  cardPriceSol: z.string(),
  devBuySol: z.string().optional(),
});

app.post("/v1/launches", wrap(async (req, res) => {
  const body = launchBody.parse(req.body);
  const symbol = body.symbol.toUpperCase();
  if (!/^[A-Z0-9]{1,13}$/.test(symbol)) throw new Error("Ticker uses letters and numbers only.");
  const cardPriceLamports = solToLamports(body.cardPriceSol);
  const devBuyLamports = solToLamports(body.devBuySol?.trim() ? body.devBuySol : "0");
  if (cardPriceLamports <= 0n) throw new Error("Enter a price per card.");
  if (cardPriceLamports > 100n * 1_000_000_000n) throw new Error("Card price must be 100 SOL or less.");
  if (devBuyLamports > 50n * 1_000_000_000n) throw new Error("Dev buy must be 50 SOL or less.");
  const image = Buffer.from(body.imageBase64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, ""), "base64");
  const prepared = await prepareLaunch({
    launcher: body.launcher,
    name: body.name,
    symbol,
    description: body.description,
    twitter: twitterOk(body.twitter),
    image,
    cardCount: body.cardCount,
    cardPriceLamports,
    devBuyLamports,
  });
  res.json(prepared);
}));

app.post("/v1/launches/:id/confirm", wrap(async (req, res) => {
  const body = z.object({ signature: z.string().min(32), launcher: z.string().min(32) }).parse(req.body);
  res.json(await confirmLaunch(req.params.id, body.signature, body.launcher));
}));

app.post("/v1/launches/:id/retry", wrap(async (req, res) => {
  const { executeLaunch } = await import("./launch.js");
  await sql`UPDATE coins SET status = 'creating', error = NULL WHERE id = ${req.params.id}::uuid AND status = 'failed' AND funding_sig IS NOT NULL`;
  await executeLaunch(req.params.id);
  const row = await getLaunch(req.params.id);
  res.json({ status: row?.status ?? "missing", error: row?.error ?? null });
}));

app.post("/v1/packs", wrap(async (req, res) => {
  const body = z.object({ buyer: z.string().min(32), tier: z.enum(["quarter", "half", "one"]) }).parse(req.body);
  res.json(await preparePack(body.buyer, body.tier));
}));

app.post("/v1/packs/:id/confirm", wrap(async (req, res) => {
  const body = z.object({ buyer: z.string().min(32), signature: z.string().min(32) }).parse(req.body);
  res.json(await confirmPack(req.params.id, body.buyer, body.signature));
}));

app.get("/v1/packs/:id", wrap(async (req, res) => {
  const rows = await sql<{ status: string; error: string | null }[]>`SELECT status, error FROM packs WHERE id = ${req.params.id}::uuid`;
  if (!rows[0]) {
    res.status(404).json({ error: "That pack does not exist." });
    return;
  }
  if (rows[0].status !== "done") {
    res.json({ id: req.params.id, status: rows[0].status, error: rows[0].error, cards: [] });
    return;
  }
  res.json(await confirmPack(req.params.id, (await sql<{ buyer_wallet: string }[]>`SELECT buyer_wallet FROM packs WHERE id = ${req.params.id}::uuid`)[0].buyer_wallet, "already"));
}));

app.post("/v1/cards/:id/buy", wrap(async (req, res) => {
  const body = z.object({ buyer: z.string().min(32) }).parse(req.body);
  res.json(await preparePrimary(req.params.id, body.buyer));
}));

app.post("/v1/cards/:id/buy/confirm", wrap(async (req, res) => {
  const body = z.object({ buyer: z.string().min(32), signature: z.string().min(32) }).parse(req.body);
  res.json(await confirmPrimary(req.params.id, body.buyer, body.signature));
}));

app.post("/v1/listings", wrap(async (req, res) => {
  const body = z.object({ cardId: z.string().uuid(), seller: z.string().min(32), priceSol: z.string() }).parse(req.body);
  const price = solToLamports(body.priceSol);
  res.json(await prepareListing(body.cardId, body.seller, price));
}));

app.post("/v1/listings/:id/confirm", wrap(async (req, res) => {
  const body = z.object({ seller: z.string().min(32), signature: z.string().min(32) }).parse(req.body);
  res.json(await confirmListing(req.params.id, body.seller, body.signature));
}));

app.post("/v1/listings/:id/buy", wrap(async (req, res) => {
  const body = z.object({ buyer: z.string().min(32) }).parse(req.body);
  res.json(await prepareListingBuy(req.params.id, body.buyer));
}));

app.post("/v1/listings/:id/buy/confirm", wrap(async (req, res) => {
  const body = z.object({ buyer: z.string().min(32), signature: z.string().min(32) }).parse(req.body);
  res.json(await confirmListingBuy(req.params.id, body.buyer, body.signature));
}));

app.post("/v1/listings/:id/cancel", wrap(async (req, res) => {
  const body = z.object({ seller: z.string().min(32) }).parse(req.body);
  res.json(await cancelListing(req.params.id, body.seller));
}));

app.get("/i/:file", (req, res) => {
  const file = path.basename(req.params.file);
  const full = path.join(dataDir(), file);
  if (!file.endsWith(".png") || !fs.existsSync(full)) {
    res.status(404).end();
    return;
  }
  res.setHeader("content-type", "image/png");
  res.setHeader("cache-control", "public, max-age=31536000, immutable");
  fs.createReadStream(full).pipe(res);
});

app.get("/m/coin/:mint.json", wrap(async (req, res) => {
  const mint = req.params.mint.replace(/\.json$/, "");
  const rows = await sql<{ name: string; symbol: string; description: string; twitter: string | null; image_path: string }[]>`
    SELECT name, symbol, description, twitter, image_path FROM coins WHERE mint = ${mint}
  `;
  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "Missing coin." });
    return;
  }
  res.json({
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    image: `${publicBase()}/i/${row.image_path}`,
    twitter: row.twitter,
    website: publicBase(),
    showName: true,
    createdOn: "https://fees.cards",
  });
}));

app.get("/m/card/:id.json", wrap(async (req, res) => {
  const id = req.params.id.replace(/\.json$/, "");
  const rows = await sql<{
    name: string;
    symbol: string;
    card_number: number;
    card_count: number;
    image_path: string | null;
    mint: string;
    coin_wallet: string;
  }[]>`
    SELECT cards.name, coins.symbol, cards.card_number, coins.card_count, cards.image_path, coins.mint, coins.coin_wallet
    FROM cards JOIN coins ON coins.id = cards.coin_id
    WHERE cards.id = ${id}::uuid
  `;
  const row = rows[0];
  if (!row?.image_path) {
    res.status(404).json({ error: "Missing card." });
    return;
  }
  res.json({
    name: row.name,
    symbol: row.symbol,
    description: `1/${row.card_count} of the creator fees for ${row.symbol}.`,
    image: `${publicBase()}/i/${row.image_path}`,
    attributes: [
      { trait_type: "Coin mint", value: row.mint },
      { trait_type: "Coin wallet", value: row.coin_wallet },
      { trait_type: "Fee share", value: `1/${row.card_count}` },
      { trait_type: "Card number", value: String(row.card_number) },
    ],
  });
}));

export { app };
