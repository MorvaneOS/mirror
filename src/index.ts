// Serves the MorvaneOS pacman repositories out of R2.
//
// Layout mirrors Arch/Artix mirrors, so pacman.conf uses:
//   Server = https://morvane.doughmination.gay/$repo/os/$arch
// Files are uploaded by publish.sh; this Worker is read-only.

export interface Env {
  REPO: R2Bucket;
}

// Databases change on every publish; package files never change once uploaded.
const DATABASE = /\.(db|files)(\.tar\.(gz|xz|zst))?(\.sig)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const key = decodeURIComponent(new URL(request.url).pathname.slice(1));

    if (key === "" || key.endsWith("/")) {
      return listing(env, key, request.method);
    }

    // pacman resumes interrupted downloads with Range requests, so pass Range and
    // conditional headers straight through to R2.
    const object = await env.REPO.get(key, { range: request.headers, onlyIf: request.headers });
    if (object === null) {
      return new Response("Not found\n", { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
    headers.set("etag", object.httpEtag);
    headers.set("last-modified", object.uploaded.toUTCString());
    headers.set("accept-ranges", "bytes");
    headers.set("cache-control", DATABASE.test(key) ? "no-cache" : "public, max-age=31536000, immutable");

    // No body means a conditional header didn't match
    if (!("body" in object)) {
      const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since");
      return new Response(null, { status: notModified ? 304 : 412, headers });
    }

    let status = 200;
    let length = object.size;
    if (request.headers.has("range") && object.range) {
      const range = object.range as { offset?: number; length?: number; suffix?: number };
      const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0);
      length = range.suffix ?? range.length ?? object.size - offset;
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      status = 206;
    }
    headers.set("content-length", String(length));

    return new Response(request.method === "HEAD" ? null : object.body, { status, headers });
  },
} satisfies ExportedHandler<Env>;

// Plain directory index, so the repo can be browsed like a normal mirror
async function listing(env: Env, prefix: string, method: string): Promise<Response> {
  const dirs: string[] = [];
  const files: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.REPO.list({ prefix, delimiter: "/", cursor });
    dirs.push(...page.delimitedPrefixes);
    files.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  if (prefix !== "" && dirs.length === 0 && files.length === 0) {
    return new Response("Not found\n", { status: 404 });
  }

  const name = (path: string) => escape(path.slice(prefix.length));
  const rows = [
    ...(prefix === "" ? [] : [`<a href="../">../</a>`]),
    ...dirs.map((d) => `<a href="${name(d)}">${name(d)}</a>`),
    ...files.map((f) => `<a href="${name(f.key)}">${name(f.key)}</a>  ${f.size} bytes  ${f.uploaded.toISOString()}`),
  ];
  const title = `MorvaneOS repository: /${escape(prefix)}`;
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1><pre>\n${rows.join("\n")}\n</pre>\n`;

  return new Response(method === "HEAD" ? null : html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
