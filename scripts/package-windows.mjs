import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const staging = path.join(release, "app-x64");
const host = path.join(root, "desktop", "Stripe.Host", "bin", "Release", "net48");
const web = path.join(root, "dist");
const output = path.join(release, "Stripe-Setup-0.3.3-x64.exe");
const icon = path.join(root, "earth.ico");
const nsisScript = path.join(root, "installer", "stripe.nsi");
const nsisCandidates = [
  path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "nsis", "nsis-3.0.4.1", "makensis.exe"),
  "makensis.exe"
];

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function copyHost() {
  const entries = await fs.readdir(host, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() || entry.name.endsWith(".pdb")) continue;
    await fs.copyFile(path.join(host, entry.name), path.join(staging, entry.name));
  }
}

async function main() {
  if (!await exists(path.join(web, "index.html"))) throw new Error("缺少前端构建结果，请先运行 npm run build:web");
  if (!await exists(path.join(host, "Stripe.exe"))) throw new Error("缺少桌面宿主，请先运行 npm run build:host");
  if (!await exists(path.join(web, "maps", "world.pmtiles"))) throw new Error("缺少离线世界地图，请先运行 npm run generate:map");
  await fs.mkdir(release, { recursive: true });
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  await copyHost();
  await fs.cp(web, path.join(staging, "web"), { recursive: true });
  await fs.copyFile(icon, path.join(staging, "earth.ico"));
  if (await exists(path.join(root, "THIRD_PARTY_NOTICES.md"))) {
    await fs.copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(staging, "THIRD_PARTY_NOTICES.md"));
  }

  const makensis = nsisCandidates.find((candidate) => candidate === "makensis.exe" || requireExists(candidate));
  const result = spawnSync(makensis, [
    "/INPUTCHARSET", "UTF8",
    `/DSOURCE_DIR=${staging}`,
    `/DOUTPUT_FILE=${output}`,
    `/DICON_FILE=${icon}`,
    nsisScript
  ], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`NSIS 打包失败\n${result.stdout}\n${result.stderr}`);
  const stat = await fs.stat(output);
  console.log(`Generated ${output} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
}

function requireExists(file) {
  try {
    return spawnSync("powershell", ["-NoProfile", "-Command", `Test-Path -LiteralPath '${file.replaceAll("'", "''")}'`], { encoding: "utf8" }).stdout.trim() === "True";
  } catch { return false; }
}

await main();
