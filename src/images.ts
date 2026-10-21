import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { dataDir } from "./env.js";

export const readImage = (name: string) => fs.promises.readFile(path.join(dataDir(), name));

export const savePng = async (name: string, png: Buffer) => {
  await fs.promises.writeFile(path.join(dataDir(), name), png);
  return name;
};

export const normalizeImage = async (input: Buffer) => {
  const image = sharp(input, { failOn: "error" });
  const meta = await image.metadata();
  if (!meta.format || !["png", "jpeg", "webp", "gif"].includes(meta.format)) {
    throw new Error("Use a PNG, JPEG, WEBP, or GIF.");
  }
  if (input.length > 2_500_000) throw new Error("That image is too large.");
  return image.resize(512, 512, { fit: "cover", kernel: "nearest" }).png().toBuffer();
};

export const frameCard = async (coinPng: Buffer) => {
  const inner = await sharp(coinPng).resize(360, 360, { fit: "cover", kernel: "nearest" }).png().toBuffer();
  const href = `data:image/png;base64,${inner.toString("base64")}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="640" shape-rendering="crispEdges">
  <rect width="512" height="640" fill="#000000"/>
  <rect x="16" y="16" width="480" height="608" fill="#B8F34A"/>
  <rect x="28" y="28" width="456" height="584" fill="#000000"/>
  <rect x="40" y="40" width="432" height="560" fill="#B8F34A"/>
  <rect x="52" y="52" width="408" height="536" fill="#122000"/>
  <image href="${href}" x="76" y="110" width="360" height="360"/>
  <rect x="76" y="110" width="360" height="8" fill="#B8F34A"/>
  <rect x="76" y="462" width="360" height="8" fill="#B8F34A"/>
  <rect x="76" y="110" width="8" height="360" fill="#B8F34A"/>
  <rect x="428" y="110" width="8" height="360" fill="#B8F34A"/>
</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
};
