type PagesContext = {
  request: Request;
  env: {
    ASSETS: {
      fetch(request: Request): Promise<Response>;
    };
  };
};

type CachedArchive = {
  bytes: ArrayBuffer;
  contentType: string;
  etag: string | null;
};

let archivePromise: Promise<CachedArchive> | null = null;

function loadArchive(context: PagesContext) {
  if (!archivePromise) {
    const request = new Request(context.request.url, {
      method: "GET",
      headers: { Accept: "application/octet-stream" }
    });
    archivePromise = context.env.ASSETS.fetch(request)
      .then(async (response) => {
        if (!response.ok) throw new Error(`PMTiles asset request failed: ${response.status}`);
        return {
          bytes: await response.arrayBuffer(),
          contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
          etag: response.headers.get("ETag")
        };
      })
      .catch((error) => {
        archivePromise = null;
        throw error;
      });
  }
  return archivePromise;
}

function parseRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;

  let start: number;
  let end: number;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

function responseHeaders(archive: CachedArchive) {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": archive.contentType
  });
  if (archive.etag) headers.set("ETag", archive.etag);
  return headers;
}

export const onRequest = async (context: PagesContext) => {
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS"
      }
    });
  }

  if (context.request.method !== "GET" && context.request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD, OPTIONS" } });
  }

  const archive = await loadArchive(context);
  const headers = responseHeaders(archive);
  const rangeHeader = context.request.headers.get("Range");
  if (!rangeHeader) {
    headers.set("Content-Length", String(archive.bytes.byteLength));
    return new Response(context.request.method === "HEAD" ? null : archive.bytes, { status: 200, headers });
  }

  const range = parseRange(rangeHeader, archive.bytes.byteLength);
  if (!range) {
    headers.set("Content-Range", `bytes */${archive.bytes.byteLength}`);
    return new Response(null, { status: 416, headers });
  }

  const body = archive.bytes.slice(range.start, range.end + 1);
  headers.set("Content-Length", String(body.byteLength));
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${archive.bytes.byteLength}`);
  return new Response(context.request.method === "HEAD" ? null : body, { status: 206, headers });
};
