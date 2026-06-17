import L from "leaflet";

const TILE_URL = "./offline-tiles/{z}/{x}/{y}.png";

export class OfflineWorldLayer extends L.TileLayer {
  constructor() {
    super(TILE_URL, {
      minZoom: 0,
      maxZoom: 10,
      maxNativeZoom: 7,
      tileSize: 256,
      noWrap: false,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 3,
      className: "offline-world-tile",
      attribution: "Natural Earth 离线地图"
    });
  }
}
