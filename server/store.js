// Small JSON file store under DATA_DIR (/data in the container, ./data locally).
import fs from "node:fs/promises";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "data");

const safeName = (name) => name.replace(/[^a-z0-9._-]+/gi, "_");

export async function readJson(name, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, safeName(name)), "utf8"));
  } catch {
    return fallback;
  }
}

// Atomic write: a crash mid-write never leaves a half-written file.
export async function writeJson(name, value) {
  const file = path.join(DATA_DIR, safeName(name));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value));
  await fs.rename(tmp, file);
}

// Results of finished events never change, so keep them on disk forever.
export async function cachedForever(name, load) {
  const hit = await readJson(`cache-${name}`);
  if (hit != null) return hit;
  const value = await load();
  if (value != null) await writeJson(`cache-${name}`, value).catch(() => {});
  return value;
}
