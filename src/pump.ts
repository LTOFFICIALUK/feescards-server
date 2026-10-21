import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  OnlinePumpSdk,
  PUMP_AMM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  bondingCurveMarketCap,
  bondingCurvePda,
  getBuyTokenAmountFromSolAmount,
  isBondingCurveMigrated,
} from "@pump-fun/pump-sdk";
import { rpc } from "./chain.js";

const online = () => new OnlinePumpSdk(rpc());

const budget = (units: number): TransactionInstruction[] => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
];

export const quoteDevBuy = async (lamports: bigint) => {
  if (lamports <= 0n) return new BN(0);
  const sdk = online();
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
  return getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: new BN(lamports.toString()),
    quoteMint: NATIVE_MINT,
  });
};

export const createAndBuyIxs = async (input: {
  mint: PublicKey;
  creator: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  devBuyLamports: bigint;
}) => {
  const createIx = await PUMP_SDK.createV2Instruction({
    mint: input.mint,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: input.creator,
    user: input.creator,
    mayhemMode: false,
  });
  if (input.devBuyLamports <= 0n) return [...budget(400_000), createIx];
  const sdk = online();
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
  const quoteAmount = new BN(input.devBuyLamports.toString());
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteAmount,
    quoteMint: NATIVE_MINT,
  });
  if (amount.lten(0)) throw new Error("That dev buy is too small to buy the coin.");
  const combined = await PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    mint: input.mint,
    name: input.name,
    symbol: input.symbol,
    uri: input.uri,
    creator: input.creator,
    user: input.creator,
    amount,
    quoteAmount,
    mayhemMode: false,
  });
  return [...budget(800_000), createIx, ...combined.slice(1)];
};

export const buyIxs = async (input: { mint: PublicKey; user: PublicKey; devBuyLamports: bigint }) => {
  const curveInfo = await rpc().getAccountInfo(bondingCurvePda(input.mint));
  if (!curveInfo) throw new Error("The coin is not on chain yet.");
  const bondingCurve = PUMP_SDK.decodeBondingCurve(curveInfo);
  const sdk = online();
  const [global, feeConfig] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig()]);
  const quoteAmount = new BN(input.devBuyLamports.toString());
  const amount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount: quoteAmount,
    quoteMint: NATIVE_MINT,
  });
  if (amount.lten(0)) throw new Error("That dev buy is too small to buy the coin.");
  const buy = await PUMP_SDK.buyV2Instructions({
    global,
    bondingCurveAccountInfo: curveInfo,
    bondingCurve,
    associatedUserAccountInfo: null,
    mint: input.mint,
    user: input.user,
    amount,
    quoteAmount,
    slippage: 5,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    quoteTokenProgram: TOKEN_PROGRAM_ID,
  });
  return [...budget(500_000), ...buy];
};

export const tokenSweepIxs = async (mint: PublicKey, from: PublicKey, to: PublicKey) => {
  const fromAta = getAssociatedTokenAddressSync(mint, from, true, TOKEN_2022_PROGRAM_ID);
  const toAta = getAssociatedTokenAddressSync(mint, to, true, TOKEN_2022_PROGRAM_ID);
  const balance = await rpc().getTokenAccountBalance(fromAta).catch(() => null);
  const amount = BigInt(balance?.value.amount ?? "0");
  if (amount <= 0n) return null;
  return {
    amount,
    instructions: [
      ...budget(200_000),
      createAssociatedTokenAccountIdempotentInstruction(from, toAta, to, mint, TOKEN_2022_PROGRAM_ID),
      createTransferCheckedInstruction(fromAta, mint, toAta, from, amount, 6, [], TOKEN_2022_PROGRAM_ID),
    ],
  };
};

export const curveState = async (mint: PublicKey) => {
  const info = await rpc().getAccountInfo(bondingCurvePda(mint));
  if (!info) return null;
  const curve = PUMP_SDK.decodeBondingCurve(info);
  const graduated = Boolean(curve.complete || isBondingCurveMigrated(curve));
  const cap = bondingCurveMarketCap({
    mintSupply: curve.tokenTotalSupply,
    virtualQuoteReserves: curve.virtualQuoteReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
  });
  return { graduated, marketCapLamports: BigInt(cap.toString()) };
};

export const collectFeeIxs = async (creator: PublicKey) => {
  const sdk = online();
  const pump = await sdk.getCreatorVaultBalance(creator);
  const both = await sdk.getCreatorVaultBalanceBothPrograms(creator);
  const amm = both.sub(pump);
  if (pump.lten(0) && amm.lten(0)) return [];
  const built = await sdk.collectCoinCreatorFeeV2Instructions(creator, NATIVE_MINT, TOKEN_PROGRAM_ID, creator);
  const filtered = built.filter((ix) => {
    if (ix.programId.equals(PUMP_PROGRAM_ID)) return pump.gtn(0);
    if (ix.programId.equals(PUMP_AMM_PROGRAM_ID)) return amm.gtn(0);
    return true;
  });
  if (!filtered.length) return [];
  return [...budget(400_000), ...filtered];
};

export const rentLamports = async (bytes: number) => BigInt(await rpc().getMinimumBalanceForRentExemption(bytes));
