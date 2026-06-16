/// <reference types="vite/client" />

declare module "world-atlas/*.json" {
  const value: import("topojson-specification").Topology;
  export default value;
}
