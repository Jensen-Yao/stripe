const fs = require("node:fs");
const path = require("node:path");
const topojson = require("topojson-client");

const root = path.resolve(__dirname, "..");
const countriesTopology = require(path.join(root, "node_modules/world-atlas/countries-10m.json"));
const jsonOutput = path.join(root, "public/data/offline-world.json");

const minPointDeltaDeg = 0.018;
const roundDigits = 4;

function round(value) {
  return Number(value.toFixed(roundDigits));
}

function simplifyLine(line) {
  const result = [];
  let previous = null;
  for (const [lon, lat] of line) {
    if (
      !previous ||
      Math.abs(lon - previous[0]) >= minPointDeltaDeg ||
      Math.abs(lat - previous[1]) >= minPointDeltaDeg ||
      Math.abs(lon - previous[0]) > 180
    ) {
      result.push([round(lon), round(lat)]);
      previous = [lon, lat];
    }
  }
  const last = line[line.length - 1];
  if (last && result.length && (result[result.length - 1][0] !== round(last[0]) || result[result.length - 1][1] !== round(last[1]))) {
    result.push([round(last[0]), round(last[1])]);
  }
  return result.length > 1 ? result : [];
}

function geometryPolygons(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates.map(simplifyLine).filter((ring) => ring.length > 2)];
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.map((polygon) => polygon.map(simplifyLine).filter((ring) => ring.length > 2));
  }
  return [];
}

const countries = topojson.feature(countriesTopology, countriesTopology.objects.countries);
const borders = topojson.mesh(countriesTopology, countriesTopology.objects.countries, (a, b) => a !== b);
const land = countries.features.flatMap((item) => geometryPolygons(item.geometry)).filter((polygon) => polygon.length);
const borderLines = borders.coordinates.map(simplifyLine).filter((line) => line.length > 1);

const payload = {
  version: 1,
  projection: "EPSG:3857",
  source: "Natural Earth countries-10m via world-atlas",
  land,
  borders: borderLines
};

fs.mkdirSync(path.dirname(jsonOutput), { recursive: true });
fs.writeFileSync(jsonOutput, JSON.stringify(payload), "utf8");
const stats = fs.statSync(jsonOutput);
console.log(`${jsonOutput} ${stats.size} bytes, ${land.length} land polygons, ${borderLines.length} border lines`);
