// Serves the MorvaneOS pacman repositories and install ISOs out of R2.
//
// Layout mirrors Arch/Artix mirrors, so pacman.conf uses:
//   Server = https://morvane.doughmination.gay/$repo/os/$arch
// Packages are uploaded by publish.sh.
//
// ISOs live in install/<version>/, where the version is the build date
// (2026.09.25, then 2026.09.25.2 for a second build that day):
//   install/latest, install/<version>                 redirect to that version's ISO
//   install/latest.sha256, install/<version>.sha256   redirect to its checksum
//   install/latest/                                   redirects to the newest version's folder
// ISOs are too big for `wrangler r2 object put`, so the release script in the
// MorvaneOS repo uploads them through this Worker, in parts. Writing needs
// UPLOAD_TOKEN (set with `wrangler secret put UPLOAD_TOKEN`) and only works
// under install/.

import { homepage, type Release } from "./home";
import { FAVICON, PALETTE } from "./style";

export interface Env {
  REPO: R2Bucket;
  UPLOAD_TOKEN?: string;
}

const VERSION = /^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/;

// Databases change on every publish; package files never change once uploaded.
const DATABASE = /\.(db|files)(\.tar\.(gz|xz|zst))?(\.sig)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.slice(1));

    if (request.method === "PUT" || request.method === "POST" || request.method === "DELETE") {
      return write(request, env, key, url.searchParams);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    const redirect = await installRedirect(env, key);
    if (redirect) return redirect;

    if (key === "") {
      const html = homepage(await latestRelease(env));
      return new Response(request.method === "HEAD" ? null : html, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    if (key.endsWith("/")) {
      return listing(env, key, request);
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

// install/latest..., install/<version> and install/<version>.sha256 point at the real files
async function installRedirect(env: Env, key: string): Promise<Response | null> {
  const match = key.match(/^install\/(latest|\d{4}\.\d{2}\.\d{2}(?:\.\d+)?)(\.sha256|\/.*)?$/);
  if (!match) return null;
  let [, version, suffix = ""] = match;

  if (version === "latest") {
    const versions = await installVersions(env);
    if (versions.length === 0) return new Response("No ISOs published yet\n", { status: 404 });
    version = versions[versions.length - 1];
  } else if (suffix.startsWith("/")) {
    return null; // a real version's folder or file
  }

  const location = suffix.startsWith("/")
    ? `/install/${version}${suffix}`
    : `/install/${version}/morvaneos-${version}-x86_64.iso${suffix}`;
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-cache" } });
}

// Published ISO versions, oldest first
async function installVersions(env: Env): Promise<string[]> {
  const page = await env.REPO.list({ prefix: "install/", delimiter: "/" });
  const numbers = (v: string) => v.split(".").map(Number);
  return page.delimitedPrefixes
    .map((p) => p.slice("install/".length, -1))
    .filter((v) => VERSION.test(v))
    .sort((a, b) => {
      const [x, y] = [numbers(a), numbers(b)];
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
      }
      return 0;
    });
}

// The newest ISO, for the homepage
async function latestRelease(env: Env): Promise<Release | null> {
  const version = (await installVersions(env)).at(-1);
  if (!version) return null;
  const iso = `install/${version}/morvaneos-${version}-x86_64.iso`;
  const [object, checksum] = await Promise.all([env.REPO.head(iso), env.REPO.get(`${iso}.sha256`)]);
  if (!object) return null;
  const sha256 = checksum ? (await checksum.text()).split(/\s/)[0] : null;
  return { version, size: object.size, sha256 };
}

// Uploads for the release script. Big files go in parts (R2 multipart uploads):
//   POST   <key>?uploads                      start; returns the upload id
//   PUT    <key>?uploadId=<id>&partNumber=<n>  one part; returns its etag
//   POST   <key>?uploadId=<id>                finish, with a JSON list of {partNumber, etag}
//   DELETE <key>?uploadId=<id>                give up
// Small files are a plain PUT <key>. DELETE <key> removes a file, and
// DELETE install/<version>/ a whole version.
async function write(request: Request, env: Env, key: string, params: URLSearchParams): Promise<Response> {
  if (!authorized(request, env)) return text("Unauthorized\n", 401);
  if (!key.startsWith("install/") || key.split("/").some((part) => part === "..")) {
    return text("Only install/ can be written\n", 403);
  }

  const uploadId = params.get("uploadId");
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  try {
    switch (request.method) {
      case "POST":
        if (params.has("uploads")) {
          return text((await env.REPO.createMultipartUpload(key, { httpMetadata: { contentType } })).uploadId);
        }
        if (uploadId) {
          const parts = await request.json<R2UploadedPart[]>();
          await env.REPO.resumeMultipartUpload(key, uploadId).complete(parts);
          return text("Done\n");
        }
        break;
      case "PUT":
        if (!request.body) return text("No body\n", 400);
        if (uploadId) {
          const upload = env.REPO.resumeMultipartUpload(key, uploadId);
          return text((await upload.uploadPart(Number(params.get("partNumber")), request.body)).etag);
        }
        await env.REPO.put(key, request.body, { httpMetadata: { contentType } });
        return text("Done\n");
      case "DELETE":
        if (uploadId) {
          await env.REPO.resumeMultipartUpload(key, uploadId).abort();
          return text("Aborted\n");
        }
        if (key.endsWith("/")) {
          // Only a single version's folder, never all of install/
          if (!/^install\/[^/]+\/$/.test(key)) return text("Can only delete a version's folder\n", 403);
          let cursor: string | undefined;
          do {
            const page = await env.REPO.list({ prefix: key, cursor });
            if (page.objects.length) await env.REPO.delete(page.objects.map((o) => o.key));
            cursor = page.truncated ? page.cursor : undefined;
          } while (cursor);
        } else {
          await env.REPO.delete(key);
        }
        return text("Deleted\n");
    }
  } catch (error) {
    return text(`${error}\n`, 500);
  }
  return text("Bad request\n", 400);
}

function authorized(request: Request, env: Env): boolean {
  if (!env.UPLOAD_TOKEN) return false;
  const encoder = new TextEncoder();
  const given = encoder.encode(request.headers.get("authorization") ?? "");
  const expected = encoder.encode(`Bearer ${env.UPLOAD_TOKEN}`);
  return given.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(given, expected);
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

// Directory index, so the repo can be browsed like a normal mirror.
// Asking for application/json gives the same as data (the release script uses it).
async function listing(env: Env, prefix: string, request: Request): Promise<Response> {
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

  if (request.headers.get("accept")?.includes("application/json")) {
    const body = JSON.stringify({
      dirs,
      files: files.map((f) => ({ key: f.key, size: f.size, uploaded: f.uploaded.toISOString() })),
    });
    return new Response(request.method === "HEAD" ? null : body, {
      headers: { "content-type": "application/json", "cache-control": "no-cache" },
    });
  }

  const html = listingPage(prefix, dirs, files);
  return new Response(request.method === "HEAD" ? null : html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

// The listing as a page in the MorvaneOS colours: folders first, then files with
// their size and upload date
function listingPage(prefix: string, dirs: string[], files: R2Object[]): string {
  const name = (path: string) => escape(path.slice(prefix.length));

  // Breadcrumb: MorvaneOS / morvane / os / x86_64 /, each part linking to its folder
  const parts = prefix.split("/").filter(Boolean);
  const crumbs = [
    `<a href="/">MorvaneOS</a>`,
    ...parts.map((part, i) => `<a href="/${parts.slice(0, i + 1).map(encodeURIComponent).join("/")}/">${escape(part)}</a>`),
  ].join(`<span class="sep">/</span>`);

  const rows = [
    ...(prefix === "" ? [] : [`<tr><td><a href="../">../</a></td><td></td><td></td></tr>`]),
    ...dirs.map((d) => `<tr><td><a class="dir" href="${name(d)}">${name(d)}</a></td><td class="num">-</td><td></td></tr>`),
    ...files.map(
      (f) => `<tr><td><a href="${name(f.key)}">${name(f.key)}</a></td>` +
        `<td class="num" title="${f.size} bytes">${humanSize(f.size)}</td>` +
        `<td class="date"><time datetime="${f.uploaded.toISOString()}">${f.uploaded.toISOString().slice(0, 16).replace("T", " ")}</time></td></tr>`,
    ),
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>/${escape(prefix)} · MorvaneOS</title>
<link rel="icon" href="${FAVICON}">
<style>
${PALETTE}
body {
  margin: 0; padding: 2.5rem 1rem; background: var(--bg); color: var(--text);
  font: 1rem/1.5 system-ui, sans-serif;
}
main { max-width: 60rem; margin: 0 auto; }
h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 1.5rem; overflow-wrap: anywhere; }
h1 a { text-decoration: none; }
h1 a:hover, h1 a:focus-visible { text-decoration: underline; }
.sep { color: var(--muted); margin: 0 0.35rem; }
.table { overflow-x: auto; border: 1px solid var(--line); border-radius: 0.5rem; }
table { width: 100%; border-collapse: collapse; font-family: ui-monospace, "JetBrains Mono", monospace; font-size: 0.9rem; }
th { text-align: left; font: 600 0.8rem system-ui, sans-serif; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; background: var(--code); }
th, td { padding: 0.45rem 1rem; white-space: nowrap; }
tbody td { border-top: 1px solid var(--line); }
tbody tr:hover { background: var(--code); }
td a { text-decoration: none; }
td a:hover, td a:focus-visible { text-decoration: underline; }
.dir { font-weight: 600; }
.num { text-align: right; color: var(--muted); }
th.num { text-align: right; }
.date { color: var(--muted); }
footer { margin-top: 1.5rem; color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>
<main>
<h1>${crumbs}<span class="sep">/</span></h1>
<div class="table">
<table>
<thead><tr><th>Name</th><th class="num">Size</th><th>Uploaded (UTC)</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>
</div>
<footer>${dirs.length} ${dirs.length === 1 ? "folder" : "folders"}, ${files.length} ${files.length === 1 ? "file" : "files"}</footer>
</main>
</body>
</html>
`;
}

function humanSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return unit === 0 ? `${size} B` : `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

function escape(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
