import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceZoom = 3;
const sourceTileSize = 256;
const overviewTileSize = 512;
const sourceTiles = 2 ** sourceZoom;
const sourceSize = sourceTiles * sourceTileSize;

async function downloadSourceTile(x, y, style) {
  const server = ((x + y) % 4) + 1;
  const host = style === 6 ? `webst0${server}.is.autonavi.com` : `webrd0${server}.is.autonavi.com`;
  const url = style === 6
    ? `https://${host}/appmaptile?style=6&x=${x}&y=${y}&z=${sourceZoom}`
    : `https://${host}/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${sourceZoom}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`高德瓦片下载失败: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const tile = bytes[0] === 0xff && bytes[1] === 0xd8
    ? jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true })
    : PNG.sync.read(bytes);
  if (tile.width !== sourceTileSize || tile.height !== sourceTileSize) throw new Error(`高德瓦片尺寸异常: ${tile.width}x${tile.height}`);
  return tile;
}

function copyTileToWorld(tile, world, tileX, tileY) {
  for (let y = 0; y < sourceTileSize; y += 1) {
    const sourceOffset = y * sourceTileSize * 4;
    const targetOffset = ((tileY * sourceTileSize + y) * sourceSize + tileX * sourceTileSize) * 4;
    world.set(tile.data.subarray(sourceOffset, sourceOffset + sourceTileSize * 4), targetOffset);
  }
}

function downsample(world, zoom) {
  const size = overviewTileSize * 2 ** zoom;
  const factor = sourceSize / size;
  const output = Buffer.alloc(size * size * 4);
  const sampleCount = factor * factor;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sums = [0, 0, 0, 0];
      for (let sampleY = 0; sampleY < factor; sampleY += 1) {
        for (let sampleX = 0; sampleX < factor; sampleX += 1) {
          const sourceOffset = (((y * factor + sampleY) * sourceSize) + x * factor + sampleX) * 4;
          sums[0] += world[sourceOffset];
          sums[1] += world[sourceOffset + 1];
          sums[2] += world[sourceOffset + 2];
          sums[3] += world[sourceOffset + 3];
        }
      }
      const targetOffset = (y * size + x) * 4;
      output[targetOffset] = Math.round(sums[0] / sampleCount);
      output[targetOffset + 1] = Math.round(sums[1] / sampleCount);
      output[targetOffset + 2] = Math.round(sums[2] / sampleCount);
      output[targetOffset + 3] = Math.round(sums[3] / sampleCount);
    }
  }
  return { data: output, size };
}

async function writeTiles(world, zoom, outputRoot, label) {
  const { data, size } = downsample(world, zoom);
  const tileCount = 2 ** zoom;
  for (let tileY = 0; tileY < tileCount; tileY += 1) {
    for (let tileX = 0; tileX < tileCount; tileX += 1) {
      const tile = new PNG({ width: overviewTileSize, height: overviewTileSize });
      for (let y = 0; y < overviewTileSize; y += 1) {
        const sourceOffset = ((tileY * overviewTileSize + y) * size + tileX * overviewTileSize) * 4;
        const targetOffset = y * overviewTileSize * 4;
        data.copy(tile.data, targetOffset, sourceOffset, sourceOffset + overviewTileSize * 4);
      }
      const directory = path.join(outputRoot, String(zoom), String(tileX));
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${tileY}.png`), PNG.sync.write(tile, { colorType: 6, inputColorType: 6 }));
    }
  }
  console.log(`${label} z${zoom}: ${tileCount * tileCount} 张球面概览瓦片`);
}

async function createOverview({ style, directory, label }) {
  const outputRoot = path.join(root, "static", "maps", directory);
  const world = Buffer.alloc(sourceSize * sourceSize * 4);
  for (let y = 0; y < sourceTiles; y += 1) {
    const row = await Promise.all(Array.from({ length: sourceTiles }, (_, x) => downloadSourceTile(x, y, style)));
    row.forEach((tile, x) => copyTileToWorld(tile, world, x, y));
  }
  await fs.rm(outputRoot, { recursive: true, force: true });
  for (let zoom = 0; zoom < sourceZoom; zoom += 1) await writeTiles(world, zoom, outputRoot, label);
}

await createOverview({ style: 8, directory: "amap-overview", label: "普通地图" });
await createOverview({ style: 6, directory: "amap-satellite-overview", label: "自然地表" });
