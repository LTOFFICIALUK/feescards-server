import assert from "node:assert/strict";
import test from "node:test";
import { equalSlices, pickPack, rankTiers, solToLamports, splitFee } from "./money.js";

test("sol string converts without float dust", () => {
  assert.equal(solToLamports("0.25"), 250_000_000n);
  assert.equal(solToLamports("1"), 1_000_000_000n);
  assert.equal(solToLamports("0.000000001"), 1n);
  assert.throws(() => solToLamports("0.1.2"));
});

test("slices are equal and the remainder stays behind", () => {
  const result = equalSlices(1003n, 10);
  assert.equal(result.share, 100n);
  assert.equal(result.used, 1000n);
  assert.equal(result.remainder, 3n);
  assert.equal(equalSlices(4n, 10).share, 0n);
});

test("primary and market fees use basis points", () => {
  assert.deepEqual(splitFee(1_000n, 1_000n), { platform: 100n, seller: 900n });
  assert.deepEqual(splitFee(10_000n, 250n), { platform: 250n, seller: 9_750n });
});

test("tiers come only from coins that actually earned fees", () => {
  const ranked = rankTiers([
    { id: "a", fees: 0n },
    { id: "b", fees: 5n },
    { id: "c", fees: 9n },
    { id: "d", fees: 1n },
    { id: "e", fees: 0n },
  ]);
  assert.equal(ranked.get("a"), null);
  assert.equal(ranked.get("e"), null);
  assert.equal(ranked.get("c"), "CHASE");
  assert.equal(ranked.get("b"), "RARE");
  assert.equal(ranked.get("d"), "COMMON");
});

test("a pack takes five cards whose prices fit the tier", () => {
  const cards = [
    { id: "1", price: 40_000_000n },
    { id: "2", price: 40_000_000n },
    { id: "3", price: 40_000_000n },
    { id: "4", price: 40_000_000n },
    { id: "5", price: 40_000_000n },
    { id: "6", price: 300_000_000n },
  ];
  const picked = pickPack(cards, 250_000_000n, "seed-a");
  assert.equal(picked?.length, 5);
  assert.equal(picked?.some((card) => card.id === "6"), false);
  assert.equal(pickPack([{ id: "x", price: 300_000_000n }], 250_000_000n, "seed-b"), null);
});
