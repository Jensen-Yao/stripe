const fs = require("node:fs");
const path = require("node:path");
const topojson = require("topojson-client");

const root = path.resolve(__dirname, "..");
const countriesTopology = require(path.join(root, "node_modules/world-atlas/countries-10m.json"));
const output = path.join(root, "src/assets/offline-world.svg");

const width = 3600;
const height = 1800;

function xy([lon, lat]) {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

function pathFromLine(line, close = false) {
  const segments = [];
  let current = [];
  for (let index = 0; index < line.length; index += 1) {
    const coordinate = line[index];
    if (index > 0) {
      const previous = line[index - 1];
      if (Math.abs(coordinate[0] - previous[0]) > 120 || Math.abs(coordinate[1] - previous[1]) > 70) {
        if (current.length > 1) segments.push(current);
        current = [];
      }
    }
    current.push(coordinate);
  }
  if (current.length > 1) segments.push(current);
  return segments
    .map((segment) => {
      const [firstX, firstY] = xy(segment[0]);
      const body = segment
        .slice(1)
        .map((point) => {
          const [x, y] = xy(point);
          return `L${x.toFixed(1)} ${y.toFixed(1)}`;
        })
        .join("");
      return `M${firstX.toFixed(1)} ${firstY.toFixed(1)}${body}${close ? "Z" : ""}`;
    })
    .join("");
}

function pathFromGeometry(geometry, close) {
  if (!geometry) return "";
  if (geometry.type === "Polygon") {
    return geometry.coordinates.map((ring) => pathFromLine(ring, close)).join("");
  }
  if (geometry.type === "MultiPolygon") {
    return geometry.coordinates.flatMap((polygon) => polygon.map((ring) => pathFromLine(ring, close))).join("");
  }
  if (geometry.type === "LineString") {
    return pathFromLine(geometry.coordinates, close);
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates.map((line) => pathFromLine(line, close)).join("");
  }
  return "";
}

const countries = topojson.feature(countriesTopology, countriesTopology.objects.countries);
const borders = topojson.mesh(countriesTopology, countriesTopology.objects.countries, (a, b) => a !== b);
const landPaths = countries.features.map((item) => pathFromGeometry(item.geometry, true)).join("");
const borderPaths = pathFromGeometry(borders, false);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="#d8e4e1"/>
  <path d="${landPaths}" fill="#d9cf78" stroke="#6e857b" stroke-width="1.15" stroke-linejoin="round" stroke-linecap="round"/>
  <path d="${borderPaths}" fill="none" stroke="#687a72" stroke-width="0.85" stroke-linejoin="round" stroke-linecap="round" opacity="0.82"/>
</svg>
`;

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, svg, "utf8");
const stats = fs.statSync(output);
console.log(`${output} ${stats.size} bytes`);
