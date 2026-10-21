import "dotenv/config";
import { migrate } from "./db.js";
import { armSeed, runSeed } from "./seed.js";

const main = async () => {
  await migrate();
  const armed = await armSeed();
  if (!armed) return;
  await runSeed();
};

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.log(error instanceof Error ? error.message : "Seed failed.");
    process.exit(1);
  });
