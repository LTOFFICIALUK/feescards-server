import "dotenv/config";
import { migrate, sql } from "./db.js";
import { app } from "./http.js";
import { executeLaunch } from "./launch.js";
import { log } from "./log.js";
import { runPayouts } from "./payouts.js";
import { runSeed } from "./seed.js";
import { expirePacks } from "./trade.js";
import { optional } from "./env.js";

const port = Number(optional("PORT") || "8787");

const main = async () => {
  await migrate();
  app.listen(port, () => {
    log("listening", { port });
  });
  const creating = await sql<{ id: string }[]>`SELECT id FROM coins WHERE status = 'creating'`;
  for (const coin of creating) void executeLaunch(coin.id);
  void runSeed();
  void tick();
  setInterval(() => void tick(), 60_000);
};

const tick = async () => {
  await expirePacks().catch((error: unknown) => log("pack expiry failed", { message: error instanceof Error ? error.message : "failed" }));
  await runPayouts().catch((error: unknown) => log("payouts failed", { message: error instanceof Error ? error.message : "failed" }));
};

main().catch((error: unknown) => {
  log("server failed", { message: error instanceof Error ? error.message : "failed" });
  process.exit(1);
});
