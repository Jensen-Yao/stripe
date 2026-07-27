import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import polygonClipping from "polygon-clipping";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, ".cache", "natural-earth");
const toolDir = path.join(root, ".tools", "pmtiles");
const outputDir = path.join(root, "static", "maps");
const mbtilesPath = path.join(root, ".cache", "world.mbtiles");
const outputPath = path.join(outputDir, "world.pmtiles");
const maxZoom = 8;

const sources = {
  countries: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson",
  states: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson",
  lakes: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson",
  rivers: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson",
  cities: "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson",
  chinaStandard: "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json"
};

async function download(url, target) {
  try { await fs.access(target); return; } catch { /* download below */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
}

async function loadSources() {
  const datasets = {};
  for (const [name, url] of Object.entries(sources)) {
    const target = path.join(cacheDir, `${name}.geojson`);
    await download(url, target);
    datasets[name] = JSON.parse(await fs.readFile(target, "utf8"));
  }
  return datasets;
}

async function ensurePmtilesCli() {
  const executable = path.join(toolDir, "pmtiles.exe");
  try { await fs.access(executable); return executable; } catch { /* download below */ }
  const archive = path.join(toolDir, "pmtiles.zip");
  await fs.mkdir(toolDir, { recursive: true });
  await download("https://github.com/protomaps/go-pmtiles/releases/download/v1.31.0/go-pmtiles_1.31.0_Windows_x86_64.zip", archive);
  const expanded = spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${toolDir.replaceAll("'", "''")}' -Force`], { stdio: "inherit" });
  if (expanded.status !== 0) throw new Error("无法解压 PMTiles CLI");
  const files = await fs.readdir(toolDir, { recursive: true });
  const candidate = files.find((file) => file.toLowerCase().endsWith("pmtiles.exe"));
  if (!candidate) throw new Error("PMTiles CLI 压缩包中没有 pmtiles.exe");
  const source = path.join(toolDir, candidate);
  if (source !== executable) await fs.copyFile(source, executable);
  return executable;
}

function tileIndex(data) {
  return geojsonvt(data, { maxZoom, indexMaxZoom: 5, indexMaxPoints: 100000, tolerance: 2.5, extent: 4096, buffer: 64, lineMetrics: false, generateId: false });
}

function geometryOnly(data) {
  return {
    type: "FeatureCollection",
    features: data.features.map((feature) => ({ type: "Feature", properties: {}, geometry: feature.geometry }))
  };
}

async function buildMbtiles(datasets) {
  const SQL = await initSqlJs({ locateFile: (file) => path.join(root, "node_modules", "sql.js", "dist", file) });
  const db = new SQL.Database();
  db.run("CREATE TABLE metadata (name TEXT, value TEXT); CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB); CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);");
  const metadata = {
    name: "Stripe Offline World",
    type: "baselayer",
    version: "1",
    description: "Natural Earth administration, water and populated places",
    format: "pbf",
    bounds: "-180,-85.05112878,180,85.05112878",
    center: "20,20,2",
    minzoom: "0",
    maxzoom: String(maxZoom),
    json: JSON.stringify({ vector_layers: [
      { id: "countries", fields: {}, minzoom: 0, maxzoom: maxZoom },
      { id: "states", fields: {}, minzoom: 3, maxzoom: maxZoom },
      { id: "lakes", fields: {}, minzoom: 0, maxzoom: maxZoom },
      { id: "rivers", fields: {}, minzoom: 2, maxzoom: maxZoom },
      { id: "china_national", fields: {}, minzoom: 0, maxzoom: maxZoom },
      { id: "china_provinces", fields: {}, minzoom: 5, maxzoom: maxZoom },
      { id: "china_maritime", fields: {}, minzoom: 0, maxzoom: maxZoom }
    ] })
  };
  const metaStatement = db.prepare("INSERT INTO metadata(name, value) VALUES (?, ?)");
  Object.entries(metadata).forEach(([name, value]) => metaStatement.run([name, value]));
  metaStatement.free();
  const tileDatasets = Object.fromEntries(
    Object.entries(datasets)
      .filter(([name]) => name !== "cities" && name !== "chinaStandard")
      .map(([name, data]) => [name, geometryOnly(data)])
  );
  const indexes = Object.fromEntries(Object.entries(tileDatasets).map(([name, data]) => [name, tileIndex(data)]));
  const insert = db.prepare("INSERT INTO tiles(zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)");
  for (let z = 0; z <= maxZoom; z += 1) {
    const count = 2 ** z;
    db.run("BEGIN");
    let written = 0;
    for (let x = 0; x < count; x += 1) {
      for (let y = 0; y < count; y += 1) {
        const layers = {};
        for (const [name, index] of Object.entries(indexes)) {
          if (name === "states" && z < 3) continue;
          if (name === "rivers" && z < 2) continue;
          if (name === "china_provinces" && z < 5) continue;
          const tile = index.getTile(z, x, y);
          if (tile?.features.length) layers[name] = tile;
        }
        if (!Object.keys(layers).length) continue;
        const bytes = vtpbf.fromGeojsonVt(layers, { version: 2, extent: 4096 });
        insert.run([z, x, count - 1 - y, bytes]);
        written += 1;
      }
    }
    db.run("COMMIT");
    console.log(`z${z}: ${written} vector tiles`);
  }
  insert.free();
  await fs.mkdir(path.dirname(mbtilesPath), { recursive: true });
  await fs.writeFile(mbtilesPath, db.export());
  db.close();
}

function prepareChinaStandard(data) {
  const chinaFeatures = data.features ?? [];
  const administrative = chinaFeatures.filter((feature) => String(feature.properties?.adcode) !== "100000_JD");
  const maritime = chinaFeatures.filter((feature) => String(feature.properties?.adcode) === "100000_JD");
  const asMultiPolygon = (geometry) => geometry?.type === "Polygon" ? [geometry.coordinates] : geometry?.coordinates ?? [];
  const nationalCoordinates = polygonClipping.union(...administrative.map((feature) => asMultiPolygon(feature.geometry)));
  const featureCollection = (features) => ({ type: "FeatureCollection", features });
  const provinceLabels = administrative
    .filter((feature) => feature.properties?.name !== "台湾省")
    .map((feature) => ({
      lon: Number(feature.properties?.center?.[0] ?? feature.properties?.centroid?.[0]),
      lat: Number(feature.properties?.center?.[1] ?? feature.properties?.centroid?.[1]),
      name: String(feature.properties?.name ?? ""),
      minZoom: ["北京市", "天津市", "上海市", "重庆市", "香港特别行政区", "澳门特别行政区"].includes(feature.properties?.name) ? 6 : 5,
      kind: "province"
    }))
    .filter((label) => Number.isFinite(label.lon) && Number.isFinite(label.lat) && label.name);
  return {
    tileDatasets: {
      china_national: featureCollection([{ type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: nationalCoordinates } }]),
      china_provinces: featureCollection(administrative.map((feature) => ({ type: "Feature", properties: {}, geometry: feature.geometry }))),
      china_maritime: featureCollection(maritime.map((feature) => ({ type: "Feature", properties: {}, geometry: feature.geometry })))
    },
    labels: [
      ...provinceLabels,
      { lon: 121.0, lat: 23.7, name: "台湾省", minZoom: 3, kind: "focus" },
      { lon: 123.47, lat: 25.75, name: "钓鱼岛", minZoom: 5, kind: "focus" },
      { lon: 114.2, lat: 13.2, name: "南海诸岛", minZoom: 2.5, kind: "focus" }
    ]
  };
}

async function main() {
  const datasets = await loadSources();
  const chinaStandard = prepareChinaStandard(datasets.chinaStandard);
  Object.assign(datasets, chinaStandard.tileDatasets);
  await buildMbtiles(datasets);
  await fs.mkdir(outputDir, { recursive: true });
  const cli = await ensurePmtilesCli();
  await fs.rm(outputPath, { force: true });
  const converted = spawnSync(cli, ["convert", mbtilesPath, outputPath], { stdio: "inherit" });
  if (converted.status !== 0) throw new Error("MBTiles 转 PMTiles 失败");
  const cities = datasets.cities.features
    .filter((feature) => feature.geometry?.type === "Point" && Number(feature.properties?.POP_MAX ?? feature.properties?.pop_max ?? 0) >= 500000)
    .map((feature) => ({
      lon: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1],
      name: feature.properties?.NAME_ZH || feature.properties?.name_zh || feature.properties?.NAME || feature.properties?.name || "城市",
      population: Number(feature.properties?.POP_MAX ?? feature.properties?.pop_max ?? 0)
    }))
    .sort((a, b) => b.population - a.population)
    .slice(0, 1200);
  await fs.writeFile(path.join(outputDir, "cities.json"), JSON.stringify(cities), "utf8");
  const countryLabels = datasets.countries.features
    .map((feature) => ({
      lon: Number(feature.properties?.LABEL_X),
      lat: Number(feature.properties?.LABEL_Y),
      name: feature.properties?.NAME_ZH || feature.properties?.NAME || feature.properties?.ADMIN || "",
      rank: Number(feature.properties?.LABELRANK ?? 9)
    }))
    .filter((label) => Number.isFinite(label.lon) && Number.isFinite(label.lat) && label.name && !/^(台湾|Taiwan)$/i.test(label.name))
    .sort((a, b) => a.rank - b.rank);
  await fs.writeFile(path.join(outputDir, "country-labels.json"), JSON.stringify(countryLabels), "utf8");
  await fs.writeFile(path.join(outputDir, "china-standard-labels.json"), JSON.stringify(chinaStandard.labels), "utf8");
  await fs.rm(path.join(outputDir, "china-standard.geojson"), { force: true });
  await fs.rm(path.join(outputDir, "world-countries.geojson"), { force: true });
  console.log(`Generated ${outputPath}`);
}

await main();
