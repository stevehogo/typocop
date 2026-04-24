import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DiscoveryFile } from "./types.js";

export async function writeDiscoveryFile(path: string, discovery: DiscoveryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
}

export async function removeDiscoveryFile(path: string): Promise<void> {
  await rm(path, { force: true });
}
