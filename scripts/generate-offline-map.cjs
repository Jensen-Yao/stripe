const fs = require("node:fs");
const path = require("node:path");
const { createCanvas } = require("canvas");
const topojson = require("topojson-client");

const root = path.resolve(__dirname, "..");
const countriesTopology = require(path.join(root, "node_modules/world-atlas/countries-10m.json"));
const tileOutput = path.join(root, "public/offline-tiles");
const metadataOutput = path.join(root, "public/data/offline-world.json");

const tileSize = 256;
const maxZoom = 7;
const maxMercatorLat = 85.05112878;
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

function lonToWorldX(lon, z) {
  return ((lon + 180) / 360) * tileSize * 2 ** z;
}

function latToWorldY(lat, z) {
  const clamped = Math.max(-maxMercatorLat, Math.min(maxMercatorLat, lat));
  const radians = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * tileSize * 2 ** z;
}

function bboxForLine(line) {
  return line.reduce(
    (bbox, [lon, lat]) => ({
      west: Math.min(bbox.west, lon),
      south: Math.min(bbox.south, lat),
      east: Math.max(bbox.east, lon),
      north: Math.max(bbox.north, lat)
    }),
    { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  );
}

function bboxForPolygon(polygon) {
  return polygon.reduce((bbox, ring) => {
    const ringBox = bboxForLine(ring);
    return {
      west: Math.min(bbox.west, ringBox.west),
      south: Math.min(bbox.south, ringBox.south),
      east: Math.max(bbox.east, ringBox.east),
      north: Math.max(bbox.north, ringBox.north)
    };
  }, { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity });
}

function tileBounds(x, y, z) {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  return {
    west,
    east,
    north: (northRad * 180) / Math.PI,
    south: (southRad * 180) / Math.PI
  };
}

function bboxOverlaps(a, b) {
  return a.east >= b.west && a.west <= b.east && a.north >= b.south && a.south <= b.north;
}

function lineCrossesDateLine(line) {
  for (let index = 1; index < line.length; index += 1) {
    if (Math.abs(line[index][0] - line[index - 1][0]) > 180) return true;
  }
  return false;
}

function drawLine(ctx, line, x, y, z, close) {
  const originX = x * tileSize;
  const originY = y * tileSize;
  let started = false;
  let previous = null;
  for (const [lon, lat] of line) {
    if (previous && Math.abs(lon - previous[0]) > 180) {
      started = false;
    }
    const px = lonToWorldX(lon, z) - originX;
    const py = latToWorldY(lat, z) - originY;
    if (!started) {
      ctx.moveTo(px, py);
      started = true;
    } else {
      ctx.lineTo(px, py);
    }
    previous = [lon, lat];
  }
  if (close && started) ctx.closePath();
}

const countries = topojson.feature(countriesTopology, countriesTopology.objects.countries);
const borders = topojson.mesh(countriesTopology, countriesTopology.objects.countries, (a, b) => a !== b);
const land = countries.features
  .flatMap((item) => geometryPolygons(item.geometry))
  .filter((polygon) => polygon.length)
  .map((polygon) => ({ rings: polygon, bbox: bboxForPolygon(polygon) }));
const borderLines = borders.coordinates
  .map(simplifyLine)
  .filter((line) => line.length > 1)
  .map((line) => ({ points: line, bbox: bboxForLine(line), dateline: lineCrossesDateLine(line) }));

fs.rmSync(tileOutput, { recursive: true, force: true });
fs.mkdirSync(path.dirname(metadataOutput), { recursive: true });
fs.writeFileSync(
  metadataOutput,
  JSON.stringify({
    version: 2,
    projection: "EPSG:3857",
    tileSize,
    maxZoom,
    source: "Natural Earth countries-10m via world-atlas",
    generatedAt: new Date().toISOString()
  }),
  "utf8"
);

for (let z = 0; z <= maxZoom; z += 1) {
  const count = 2 ** z;
  const landWidth = Math.max(0.9, Math.min(1.6, z * 0.23));
  const borderWidth = Math.max(0.5, Math.min(1.05, z * 0.14));
  for (let x = 0; x < count; x += 1) {
    for (let y = 0; y < count; y += 1) {
      const canvas = createCanvas(tileSize, tileSize);
      const ctx = canvas.getContext("2d");
      const bounds = tileBounds(x, y, z);
      const paddedBounds = {
        west: bounds.west - 1.5,
        east: bounds.east + 1.5,
        north: bounds.north + 1.5,
        south: bounds.south - 1.5
      };

      ctx.fillStyle = "#d8e4e1";
      ctx.fillRect(0, 0, tileSize, tileSize);

      ctx.beginPath();
      for (const polygon of land) {
        if (!bboxOverlaps(polygon.bbox, paddedBounds)) continue;
        for (const ring of polygon.rings) drawLine(ctx, ring, x, y, z, true);
      }
      ctx.fillStyle = "#d9cf78";
      ctx.fill("evenodd");
      ctx.strokeStyle = "#6e857b";
      ctx.lineWidth = landWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      ctx.beginPath();
      for (const line of borderLines) {
        if (!line.dateline && !bboxOverlaps(line.bbox, paddedBounds)) continue;
        drawLine(ctx, line.points, x, y, z, false);
      }
      ctx.strokeStyle = "rgba(89,111,103,0.72)";
      ctx.lineWidth = borderWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      const tileFile = path.join(tileOutput, String(z), String(x), `${y}.png`);
      fs.mkdirSync(path.dirname(tileFile), { recursive: true });
      fs.writeFileSync(tileFile, canvas.toBuffer("image/png", { compressionLevel: 9 }));
    }
  }
  console.log(`offline tiles z${z}: ${count * count}`);
}

console.log(`${tileOutput} generated, maxZoom=${maxZoom}`);
