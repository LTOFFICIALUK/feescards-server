export const LAMPORTS = 1_000_000_000n;
export const MIN_RESERVE = 2_000_000n;
export const PRIMARY_FEE_BPS = 1_000n;
export const MARKET_FEE_BPS = 250n;
export const BPS = 10_000n;

export const PACKS = [
  { tier: "quarter", lamports: 250_000_000n, cards: 5 },
  { tier: "half", lamports: 500_000_000n, cards: 5 },
  { tier: "one", lamports: 1_000_000_000n, cards: 5 },
] as const;

export type PackTier = (typeof PACKS)[number]["tier"];
export type CardTier = "CHASE" | "RARE" | "COMMON";

export const packByTier = (tier: string) => PACKS.find((pack) => pack.tier === tier) ?? null;

export const solToLamports = (input: string) => {
  const value = input.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(value)) {
    throw new Error("Enter a SOL amount.");
  }
  const [whole, frac = ""] = value.split(".");
  return BigInt(whole) * LAMPORTS + BigInt(frac.padEnd(9, "0"));
};

export const equalSlices = (total: bigint, count: number) => {
  if (count <= 0 || total <= 0n) return { share: 0n, used: 0n, remainder: total > 0n ? total : 0n };
  const share = total / BigInt(count);
  const used = share * BigInt(count);
  return { share, used, remainder: total - used };
};

export const splitFee = (price: bigint, feeBps: bigint) => {
  const platform = (price * feeBps) / BPS;
  return { platform, seller: price - platform };
};

export type FeeRow = { id: string; fees: bigint };

export const rankTiers = (rows: FeeRow[]) => {
  const out = new Map<string, CardTier | null>();
  for (const row of rows) out.set(row.id, null);
  const positive = rows.filter((row) => row.fees > 0n).sort((a, b) => (a.fees > b.fees ? -1 : a.fees < b.fees ? 1 : 0));
  if (!positive.length) return out;
  if (positive.length === 1) {
    out.set(positive[0].id, "CHASE");
    return out;
  }
  if (positive.length === 2) {
    out.set(positive[0].id, "CHASE");
    out.set(positive[1].id, "RARE");
    return out;
  }
  const chaseCount = Math.max(1, Math.ceil(positive.length * 0.2));
  const rareCount = Math.max(1, Math.ceil(positive.length * 0.3));
  positive.forEach((row, index) => {
    if (index < chaseCount) out.set(row.id, "CHASE");
    else if (index < chaseCount + rareCount) out.set(row.id, "RARE");
    else out.set(row.id, "COMMON");
  });
  return out;
};

export type PricedCard = { id: string; price: bigint };

const mix = (seed: string) => {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    state ^= seed.charCodeAt(i);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffle = <T>(items: T[], seed: string) => {
  const copy = [...items];
  const random = mix(seed);
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
};

export const pickPack = (cards: PricedCard[], tierLamports: bigint, seed: string) => {
  const shuffled = shuffle(cards, seed);
  const picked: PricedCard[] = [];
  let sum = 0n;
  for (const card of shuffled) {
    if (picked.length === 5) break;
    if (sum + card.price <= tierLamports) {
      picked.push(card);
      sum += card.price;
    }
  }
  if (picked.length === 5) return picked;
  const cheapest = [...cards].sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0)).slice(0, 5);
  const cheapSum = cheapest.reduce((total, card) => total + card.price, 0n);
  if (cheapest.length === 5 && cheapSum <= tierLamports) return cheapest;
  return null;
};
