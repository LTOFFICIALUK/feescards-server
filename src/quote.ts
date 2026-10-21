import { rentLamports } from "./pump.js";

export const quoteLaunchLamports = async (cardCount: number, devBuyLamports: bigint) => {
  const [mintRent, curveRent, ataRent, extensionRent, coreAsset, collection] = await Promise.all([
    rentLamports(800),
    rentLamports(166),
    rentLamports(165),
    rentLamports(250),
    rentLamports(450),
    rentLamports(300),
  ]);
  const volume = 1_844_400n;
  const txFees = 80_000n;
  const safety = 8_000_000n;
  const create = mintRent + curveRent + ataRent * 4n + extensionRent * 2n + volume + txFees;
  const cards = collection + coreAsset * BigInt(cardCount) + 15_000n * BigInt(cardCount);
  return create + cards + safety + devBuyLamports;
};
