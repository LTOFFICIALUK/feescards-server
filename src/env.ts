import fs from "node:fs";
import path from "node:path";

export const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};

export const optional = (name: string) => process.env[name]?.trim() || "";

export const dataDir = () => {
  const dir = path.join(process.cwd(), "data", "images");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

export const publicBase = () => required("PUBLIC_BASE_URL").replace(/\/$/, "");
