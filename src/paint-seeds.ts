import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const palette = ["#00000000", "#122000", "#B8F34A", "#F2EEE3", "#8F8A7E", "#F2C14E"];

const hex = (value: string) => [
  Number.parseInt(value.slice(1, 3), 16),
  Number.parseInt(value.slice(3, 5), 16),
  Number.parseInt(value.slice(5, 7), 16),
  value.length > 7 ? Number.parseInt(value.slice(7, 9), 16) : 255,
];

const paint = (rows: string[], scale: number) => {
  const height = rows.length;
  const width = rows[0].length;
  const png = new PNG({ width: width * scale, height: height * scale });
  rows.forEach((row, y) => {
    [...row].forEach((cell, x) => {
      const [r, g, b, a] = hex(palette[Number(cell)] ?? palette[0]);
      for (let dy = 0; dy < scale; dy += 1) {
        for (let dx = 0; dx < scale; dx += 1) {
          const index = ((y * scale + dy) * png.width + (x * scale + dx)) * 4;
          png.data[index] = r;
          png.data[index + 1] = g;
          png.data[index + 2] = b;
          png.data[index + 3] = a;
        }
      }
    });
  });
  return PNG.sync.write(png);
};

const solid = (width: number, height: number, rgba: [number, number, number, number]) => {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = rgba[0];
    png.data[i + 1] = rgba[1];
    png.data[i + 2] = rgba[2];
    png.data[i + 3] = rgba[3];
  }
  return PNG.sync.write(png);
};

const blit = (base: Buffer, sprite: Buffer, x: number, y: number) => {
  const dest = PNG.sync.read(base);
  const src = PNG.sync.read(sprite);
  for (let row = 0; row < src.height; row += 1) {
    for (let col = 0; col < src.width; col += 1) {
      const from = (row * src.width + col) * 4;
      if (src.data[from + 3] === 0) continue;
      const tx = x + col;
      const ty = y + row;
      if (tx < 0 || ty < 0 || tx >= dest.width || ty >= dest.height) continue;
      const to = (ty * dest.width + tx) * 4;
      dest.data[to] = src.data[from];
      dest.data[to + 1] = src.data[from + 1];
      dest.data[to + 2] = src.data[from + 2];
      dest.data[to + 3] = src.data[from + 3];
    }
  }
  return PNG.sync.write(dest);
};

const font: Record<string, string[]> = {
  A: ["010", "101", "111", "101", "101"],
  C: ["111", "100", "100", "100", "111"],
  D: ["110", "101", "101", "101", "110"],
  E: ["111", "100", "110", "100", "111"],
  F: ["111", "100", "110", "100", "100"],
  H: ["101", "101", "111", "101", "101"],
  P: ["111", "101", "111", "100", "100"],
  R: ["111", "101", "111", "101", "101"],
  S: ["111", "100", "111", "001", "111"],
  T: ["111", "010", "010", "010", "010"],
  Y: ["101", "101", "010", "010", "010"],
  O: ["111", "101", "101", "101", "111"],
  U: ["101", "101", "101", "101", "111"],
  ".": ["000", "000", "000", "000", "010"],
  " ": ["000", "000", "000", "000", "000"],
};

const text = (value: string, scale: number) => {
  const rows = ["", "", "", "", ""];
  [...value].forEach((glyph, index) => {
    const bits = font[glyph] ?? font[" "];
    bits.forEach((row, y) => {
      rows[y] += (index ? "0" : "") + row;
    });
  });
  return paint(rows.map((row) => row.replaceAll("0", "0").replaceAll("1", "2")), scale);
};

const pets: Record<string, string[]> = {
  feescat: [
    "0002200002200000",
    "0022220002222000",
    "0222222222222200",
    "0222332222332200",
    "0222032222032200",
    "0222222222222200",
    "0222222222222200",
    "0222111111122200",
    "0022222222222000",
    "0002222222220000",
    "0000222222200000",
    "0002220002220000",
    "0022200000222000",
    "0222000000022200",
    "0022000000022000",
    "0000000000000000",
  ],
  paydaypup: [
    "0000000220000000",
    "0000002222000000",
    "0002222222220000",
    "0022332222332000",
    "0022032222032000",
    "0022222222222000",
    "0002221112220000",
    "0000222222200000",
    "0002222222220000",
    "0022222222222000",
    "0222222222222200",
    "0222000000022200",
    "0022000000022000",
    "0002200000220000",
    "0002000000020000",
    "0000000000000000",
  ],
  rentfrog: [
    "0002200000022000",
    "0022220000222200",
    "0222222222222220",
    "0222332222233220",
    "0222032222230220",
    "0222222222222220",
    "0022211111122200",
    "0002222222222000",
    "0000222222220000",
    "0002222222222000",
    "0022222222222200",
    "0222200000022220",
    "0220000000000220",
    "0200000000000020",
    "0000000000000000",
    "0000000000000000",
  ],
  royaltyrat: [
    "0200000000000020",
    "0020000000000200",
    "0002222222220000",
    "0022332222332000",
    "0022032222032550",
    "0022222222222550",
    "0002221112220000",
    "0000222222200000",
    "0002222222220000",
    "0022222222222000",
    "0002220002220000",
    "0002200000220000",
    "0002000000020000",
    "0020000000002000",
    "0200000000000200",
    "0000000000000000",
  ],
  tiphamster: [
    "0000222222200000",
    "0002222222220000",
    "0022222222222000",
    "0222332222332200",
    "0222032222032200",
    "0222222222222200",
    "0022211111122200",
    "0002222222222000",
    "0022222222222200",
    "0222222222222220",
    "0222000000002220",
    "0022200000022200",
    "0002220000222000",
    "0000222222200000",
    "0000000000000000",
    "0000000000000000",
  ],
};

const root = path.resolve(process.cwd(), "..");
const outs = [
  path.join(process.cwd(), "seeds"),
  path.join(root, "brand", "seeds"),
];
for (const dir of outs) fs.mkdirSync(dir, { recursive: true });
for (const [name, rows] of Object.entries(pets)) {
  const png = paint(rows, 32);
  for (const dir of outs) fs.writeFileSync(path.join(dir, `${name}.png`), png);
}

const face = paint(
  [
    "0001111111111000",
    "0011111111111100",
    "0111111111111110",
    "1111111111111111",
    "1110011110011111",
    "1110011110011111",
    "1111111111111111",
    "1111111111111111",
    "1111111111111111",
    "1101111111110111",
    "1110111111101111",
    "1111000000011111",
    "0111111111111110",
    "0011111111111100",
    "0001111111111000",
    "0000000000000000",
  ].map((row) => row.replaceAll("1", "3")),
  32,
);
fs.writeFileSync(path.join(root, "brand", "feescards-pfp.png"), face);

const banner = solid(1500, 500, [0, 0, 0, 255]);
const bannerFace = paint(
  [
    "0001111111111000",
    "0011111111111100",
    "0111111111111110",
    "1111111111111111",
    "1110011110011111",
    "1110011110011111",
    "1111111111111111",
    "1111111111111111",
    "1111111111111111",
    "1101111111110111",
    "1110111111101111",
    "1111000000011111",
    "0111111111111110",
    "0011111111111100",
    "0001111111111000",
  ].map((row) => row.replaceAll("1", "2")),
  18,
);
const word = text("FEES.CARDS", 8);
const line = text("CARDS THAT PAY YOU.", 6);
let composed = blit(banner, bannerFace, 80, 90);
composed = blit(composed, word, 420, 160);
composed = blit(composed, line, 420, 280);
fs.writeFileSync(path.join(root, "brand", "feescards-banner.png"), composed);

const og = solid(1200, 630, [0, 0, 0, 255]);
const ogFace = paint(
  [
    "0001111111111000",
    "0011111111111100",
    "0111111111111110",
    "1111111111111111",
    "1110011110011111",
    "1110011110011111",
    "1111111111111111",
    "1111111111111111",
    "1111111111111111",
    "1101111111110111",
    "1110111111101111",
    "1111000000011111",
    "0111111111111110",
    "0011111111111100",
    "0001111111111000",
  ].map((row) => row.replaceAll("1", "2")),
  16,
);
let card = blit(og, ogFace, 90, 180);
card = blit(card, text("FEES.CARDS", 8), 420, 180);
card = blit(card, text("CARDS THAT", 8), 420, 280);
card = blit(card, text("PAY YOU.", 8), 420, 380);
fs.writeFileSync(path.join(root, "brand", "feescards-og.png"), card);
fs.mkdirSync(path.join(root, "frontend", "public"), { recursive: true });
fs.writeFileSync(path.join(root, "frontend", "public", "og.png"), card);
fs.writeFileSync(path.join(root, "frontend", "public", "pfp.png"), face);
console.log("painted seeds and social images");
