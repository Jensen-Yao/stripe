# Stripe Satellite Planner

Windows desktop tool for drawing four-corner satellite planning stripes on a world map and visualizing TLE-based satellite positions.

## Features

- Offline Natural Earth world map with country borders and online OpenStreetMap base map.
- Four-click stripe creation with corner dragging, moving, rotation, and stretch controls.
- Copyable coordinate output in `[lon, lat]` or `[lat, lon]` order.
- TLE input by manual paste, CelesTrak fetch, or Space-Track fetch.
- SGP4/SDP4 orbit propagation with current sub-satellite point, one-orbit ground track, and nadir sensor half-cone coverage circle.
- Project import/export as JSON.

## Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm start
```

Orbit propagation is intended for planning visualization, not precision mission operations or collision analysis.
