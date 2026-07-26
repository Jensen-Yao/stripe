import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tools = path.join(root, ".tools");
const jdkRoot = path.join(tools, "jdk-21");
const archive = path.join(tools, "jdk-21.zip");
const engine = path.join(root, "orbit-engine");
const data = path.join(engine, "data");

async function exists(target) { try { await fs.access(target); return true; } catch { return false; } }

async function download(url, target) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function ensureJdk() {
  const java = path.join(jdkRoot, "bin", "java.exe");
  if (await exists(java)) return jdkRoot;
  await fs.mkdir(tools, { recursive: true });
  if (!await exists(archive)) await download("https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse", archive);
  const expanded = path.join(tools, "jdk-expand");
  await fs.rm(expanded, { recursive: true, force: true });
  const result = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${expanded.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("JDK 21 解压失败");
  const children = await fs.readdir(expanded, { withFileTypes: true });
  const directory = children.find((item) => item.isDirectory());
  if (!directory) throw new Error("JDK 21 压缩包结构异常");
  await fs.rm(jdkRoot, { recursive: true, force: true });
  await fs.rename(path.join(expanded, directory.name), jdkRoot);
  await fs.rm(expanded, { recursive: true, force: true });
  return jdkRoot;
}

async function ensureOrekitData() {
  if (await exists(path.join(data, "UTC-TAI.history"))) return;
  const zip = path.join(tools, "orekit-data.zip");
  await download("https://gitlab.orekit.org/orekit/orekit-data/-/archive/master/orekit-data-master.zip", zip);
  const expanded = path.join(tools, "orekit-data-expand");
  await fs.rm(expanded, { recursive: true, force: true });
  const result = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${expanded.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Orekit 数据解压失败");
  const children = await fs.readdir(expanded, { withFileTypes: true });
  const directory = children.find((item) => item.isDirectory());
  if (!directory) throw new Error("Orekit 数据包结构异常");
  await fs.rm(data, { recursive: true, force: true });
  await fs.rename(path.join(expanded, directory.name), data);
  await fs.rm(expanded, { recursive: true, force: true });
}

async function main() {
  const javaHome = await ensureJdk();
  await ensureOrekitData();
  const environment = { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, "bin")};${process.env.PATH}` };
  const built = spawnSync("mvn", ["-q", "-DskipTests", "package"], { cwd: engine, env: environment, stdio: "inherit", shell: true });
  if (built.status !== 0) throw new Error("Orekit 服务构建失败");
  const runtime = path.join(engine, "runtime");
  await fs.rm(runtime, { recursive: true, force: true });
  const linked = spawnSync(path.join(javaHome, "bin", "jlink.exe"), ["--add-modules", "java.base,java.logging,java.xml,java.net.http,java.desktop,jdk.unsupported", "--strip-debug", "--no-header-files", "--no-man-pages", "--compress=2", "--output", runtime], { env: environment, stdio: "inherit" });
  if (linked.status !== 0) throw new Error("Java 精简运行时构建失败");
}

await main();
