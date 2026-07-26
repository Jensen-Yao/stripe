import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [path.join(root, "dist"), path.join(root, "dist-electron")];

for (const target of targets) {
  if (!target.startsWith(root + path.sep)) throw new Error(`拒绝清理工作区外路径：${target}`);
  await fs.rm(target, { recursive: true, force: true });
}
