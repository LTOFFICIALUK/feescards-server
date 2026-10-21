import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  create,
  createCollection,
  fetchCollectionV1,
  mplCore,
  safeFetchAllAssetV1,
  transferV1,
} from "@metaplex-foundation/mpl-core";
import {
  createNoopSigner,
  createSignerFromKeypair,
  keypairIdentity,
  publicKey,
  signerIdentity,
  type Umi,
} from "@metaplex-foundation/umi";
import { fromWeb3JsKeypair, toWeb3JsInstruction, toWeb3JsTransaction } from "@metaplex-foundation/umi-web3js-adapters";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { required } from "./env.js";
import { escrowWallet } from "./keys.js";
import { log } from "./log.js";

const umiFor = (wallet?: Keypair) => {
  const umi = createUmi(required("HELIUS_RPC_URL")).use(mplCore());
  if (!wallet) return { umi, signer: null };
  const signer = createSignerFromKeypair(umi, fromWeb3JsKeypair(wallet));
  umi.use(keypairIdentity(signer));
  return { umi, signer };
};

const signatureOf = (signature: Uint8Array) => bs58.encode(signature);

export const createCardCollection = async (payer: Keypair, collection: Keypair, name: string, uri: string) => {
  const { umi, signer } = umiFor(payer);
  if (!signer) throw new Error("Missing collection payer.");
  const collectionSigner = createSignerFromKeypair(umi, fromWeb3JsKeypair(collection));
  const result = await createCollection(umi, { collection: collectionSigner, name, uri }).sendAndConfirm(umi);
  return signatureOf(result.signature);
};

export const createCardAsset = async (input: {
  payer: Keypair;
  asset: Keypair;
  collection: string;
  owner: string;
  name: string;
  uri: string;
  attributes: { key: string; value: string }[];
}) => {
  const { umi } = umiFor(input.payer);
  const asset = createSignerFromKeypair(umi, fromWeb3JsKeypair(input.asset));
  const collection = await fetchCollectionV1(umi, publicKey(input.collection));
  const result = await create(umi, {
    asset,
    collection,
    name: input.name,
    uri: input.uri,
    owner: publicKey(input.owner),
    plugins: [{ type: "Attributes", attributeList: input.attributes }],
  }).sendAndConfirm(umi);
  return signatureOf(result.signature);
};

export const transferAsset = async (payer: Keypair, asset: string, collection: string, newOwner: string) => {
  const owners = await chainOwners([asset]);
  if (owners.get(asset) === newOwner) return null;
  const { umi, signer } = umiFor(payer);
  if (!signer) throw new Error("Missing transfer signer.");
  const result = await transferV1(umi, {
    asset: publicKey(asset),
    collection: publicKey(collection),
    authority: signer,
    newOwner: publicKey(newOwner),
  }).sendAndConfirm(umi);
  return signatureOf(result.signature);
};

export const chainOwners = async (assets: string[]) => {
  if (!assets.length) return new Map<string, string>();
  const { umi } = umiFor();
  const fetched = await safeFetchAllAssetV1(umi, assets.map((asset) => publicKey(asset)));
  const out = new Map<string, string>();
  for (const asset of fetched) {
    if (!asset) continue;
    out.set(asset.publicKey.toString(), asset.owner.toString());
  }
  return out;
};

export const dasOwners = async (collection: string) => {
  const out = new Map<string, string>();
  let page = 1;
  for (;;) {
    const response = await fetch(required("HELIUS_RPC_URL"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "assets",
        method: "getAssetsByGroup",
        params: { groupKey: "collection", groupValue: collection, page, limit: 1000 },
      }),
    });
    if (!response.ok) throw new Error("Helius did not return card owners.");
    const body = (await response.json()) as {
      result?: { items?: { id?: string; ownership?: { owner?: string } }[] };
    };
    const items = body.result?.items ?? [];
    for (const item of items) {
      if (item.id && item.ownership?.owner) out.set(item.id, item.ownership.owner);
    }
    if (items.length < 1000) break;
    page += 1;
  }
  return out;
};

export const ownersForCollection = async (collection: string, assets: string[]) => {
  const [chain, indexed] = await Promise.all([
    chainOwners(assets),
    dasOwners(collection).catch((error: unknown) => {
      log("das lookup failed", { collection, message: error instanceof Error ? error.message : "failed" });
      return new Map<string, string>();
    }),
  ]);
  for (const [asset, owner] of indexed) {
    const onChain = chain.get(asset);
    if (onChain && onChain !== owner) log("das owner differs from chain", { asset });
  }
  if (chain.size) return chain;
  return indexed;
};

export const listingTransaction = async (input: {
  seller: string;
  asset: string;
  collection: string;
}) => {
  const umi = createUmi(required("HELIUS_RPC_URL")).use(mplCore());
  const seller = createNoopSigner(publicKey(input.seller));
  umi.use(signerIdentity(seller));
  const builder = transferV1(umi, {
    asset: publicKey(input.asset),
    collection: publicKey(input.collection),
    authority: seller,
    newOwner: publicKey(escrowWallet().publicKey.toBase58()),
    payer: seller,
  });
  const blockhash = await umi.rpc.getLatestBlockhash();
  const built = await builder.setBlockhash(blockhash).build(umi as Umi);
  const web3Tx = toWeb3JsTransaction(built);
  if (web3Tx instanceof Transaction) {
    return Buffer.from(web3Tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
  }
  const instructions = builder.getInstructions().map((ix) => toWeb3JsInstruction(ix));
  const tx = new Transaction({
    feePayer: new PublicKey(input.seller),
    recentBlockhash: blockhash.blockhash,
  }).add(...instructions);
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
};
