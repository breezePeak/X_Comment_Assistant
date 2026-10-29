import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateCollection, mergePosts, validateImpression, mergeImpressions } from "./analytics-data.mjs";

const MAX_BODY = 30 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const digest = value => createHash("sha256").update(value).digest();
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function string(value, name, max, optional = false) {
  if (optional && value === undefined) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.length > max) fail(400, `${name} 必须是${optional ? "" : "非空"}文字，最多 ${max} 字符。`);
  return value.trim();
}

function httpsUrl(value) {
  const text = string(value, "链接", 2048);
  let url;
  try { url = new URL(text); } catch { fail(400, "链接无效。"); }
  if (url.protocol !== "https:" || url.username || url.password) fail(400, "图片和来源链接必须使用不含账号密码的 HTTPS 地址。");
  return url.href;
}

function validatePost(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(400, "请求必须是 JSON 对象。");
  const externalId = string(input.externalId, "externalId", 200);
  const title = string(input.title, "title", 200, true);
  const text = string(input.text, "text", 25000);
  if (!Array.isArray(input.images) || input.images.length < 1 || input.images.length > 4) fail(400, "images 必须包含 1—4 张图片。");
  const images = input.images.map(image => {
    if (!image || typeof image !== "object" || Array.isArray(image)) fail(400, "图片格式无效。");
    const alt = string(image.alt, "图片说明", 1000, true);
    if (image.url !== undefined) {
      if (image.base64 !== undefined || image.mimeType !== undefined) fail(400, "每张图片只能选择 url 或 base64 + mimeType。");
      return { url: httpsUrl(image.url), alt };
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(image.mimeType) || typeof image.base64 !== "string" ||
        !image.base64.length || image.base64.length > Math.ceil(MAX_IMAGE / 3) * 4 ||
        image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)) fail(400, "图片必须是 PNG / JPEG / WebP 的标准 Base64，每张最多 5 MiB。");
    const data = Buffer.from(image.base64, "base64");
    const valid = image.mimeType === "image/png" ? data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) :
      image.mimeType === "image/jpeg" ? data.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) :
        data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP";
    if (!valid || data.length > MAX_IMAGE || data.toString("base64") !== image.base64) fail(400, "图片内容与 MIME 类型不匹配、编码无效或超过 5 MiB。");
    return { mimeType: image.mimeType, base64: data.toString("base64"), alt };
  });
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 10) fail(400, "sources 最多 10 项。");
  return { externalId, title, text, images, sources: sources.map(source => ({
    title: string(source?.title, "来源标题", 200, true), url: httpsUrl(source?.url)
  })) };
}

async function readJson(req) {
  if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") fail(415, "请使用 application/json。");
  if (Number(req.headers["content-length"]) > MAX_BODY) fail(413, "请求不能超过 30 MiB。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail(413, "请求不能超过 30 MiB。");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail(400, "JSON 格式无效。"); }
}

export function createPostServer({ token, databasePath, localOnly = false }) {
  if (!localOnly && (typeof token !== "string" || !/^[\x21-\x7e]{32,256}$/.test(token))) throw new Error("POSTS_API_TOKEN 必须是 32—256 位非空格 ASCII 字符；请使用随机密钥。");
  if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT NOT NULL UNIQUE,
      fingerprint TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
      sources TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS images (
      post_id INTEGER NOT NULL REFERENCES posts(id), position INTEGER NOT NULL,
      alt TEXT NOT NULL, url TEXT, mime_type TEXT, data BLOB,
      PRIMARY KEY (post_id, position)
    );
    CREATE TABLE IF NOT EXISTS own_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, post_id TEXT NOT NULL,
      snapshot TEXT NOT NULL, UNIQUE(owner, post_id)
    );
    CREATE INDEX IF NOT EXISTS own_posts_owner_id ON own_posts(owner, id);
    CREATE TABLE IF NOT EXISTS original_impressions (
      owner TEXT NOT NULL, date TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(owner, date)
    );
    CREATE TABLE IF NOT EXISTS friendly_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, style TEXT NOT NULL,
      text TEXT NOT NULL UNIQUE, consumed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_friendly_consumed ON friendly_comments(consumed);`);
  const tokenHash = digest(`Bearer ${token}`);
  function publicPost(row) {
    return { id: row.id, externalId: row.external_id, title: row.title, text: row.text,
      sources: JSON.parse(row.sources), createdAt: row.created_at, consumedAt: row.consumed_at,
      images: db.prepare("SELECT position, alt, url, mime_type FROM images WHERE post_id = ? ORDER BY position").all(row.id)
        .map(image => ({ alt: image.alt, mimeType: image.mime_type,
          ...(image.url ? { url: image.url } : { path: `/api/posts/${row.id}/images/${image.position}` }) })) };
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      if (localOnly) {
        const port = server.address()?.port;
        const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
        const origin = req.headers.origin;
        const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(origin || "");
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) ||
            !origins.some(value => value.slice(7) === req.headers.host) ||
            (origin && !extension && !origins.includes(origin)) ||
            (!extension && req.headers["sec-fetch-site"] === "cross-site")) fail(403, "本地服务仅允许本机程序和扩展访问。");
      }
      if (req.method === "GET" && url.pathname === "/healthz") return json(200, localOnly ? { ok: true, service: "x-comment-assistant", localOnly: true } : { ok: true });
      if (!localOnly && !timingSafeEqual(tokenHash, digest(req.headers.authorization || ""))) {
        res.setHeader("WWW-Authenticate", "Bearer");
        res.setHeader("Connection", "close");
        return json(401, { error: "Token 无效或缺失。" });
      }
      if (req.method === "POST" && url.pathname === "/api/analytics/impressions") {
        let row;
        try { row = validateImpression(await readJson(req)); } catch (error) { fail(error.status || 400, error.message); }
        db.exec("BEGIN IMMEDIATE");
        try {
          const rows = db.prepare("SELECT snapshot FROM original_impressions WHERE owner = ? AND (date = ? OR date = (SELECT MAX(date) FROM original_impressions WHERE owner = ?)) ORDER BY date").all(row.owner, row.date, row.owner).map(item => JSON.parse(item.snapshot));
          if (mergeImpressions(rows, [row]).includes(row)) {
            db.prepare("INSERT INTO original_impressions (owner, date, snapshot) VALUES (?, ?, ?) ON CONFLICT(owner, date) DO UPDATE SET snapshot = excluded.snapshot").run(row.owner, row.date, JSON.stringify(row));
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        return json(200, { accepted: 1 });
      }
      if (req.method === "GET" && url.pathname === "/api/analytics/impressions") {
        const owner = url.searchParams.get("owner");
        if (!/^[a-z0-9_]{1,15}$/.test(owner || "")) fail(400, "账号无效。");
        const rows = db.prepare("SELECT snapshot FROM original_impressions WHERE owner = ? ORDER BY date DESC").all(owner);
        return json(200, { owner, impressions: rows.map(row => JSON.parse(row.snapshot)) });
      }
      if (req.method === "POST" && url.pathname === "/api/analytics/posts") {
        const input = await readJson(req);
        if (!Array.isArray(input?.posts) || input.posts.length < 1 || input.posts.length > 100) fail(400, "每批帖子须为 1—100 条。");
        let collection;
        try { collection = validateCollection(input); } catch (error) { fail(400, error.message); }
        const read = db.prepare("SELECT snapshot FROM own_posts WHERE owner = ? AND post_id = ?");
        const upsert = db.prepare("INSERT INTO own_posts (owner, post_id, snapshot) VALUES (?, ?, ?) ON CONFLICT(owner, post_id) DO UPDATE SET snapshot = excluded.snapshot");
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const post of collection.posts) {
            const row = read.get(collection.owner, post.id);
            const old = row ? JSON.parse(row.snapshot) : null;
            const [next] = mergePosts(old ? [old] : [], [post]);
            if (next !== old) upsert.run(collection.owner, post.id, JSON.stringify(next));
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        return json(200, { accepted: collection.posts.length });
      }
      if (req.method === "GET" && url.pathname === "/api/analytics/posts") {
        const owner = url.searchParams.get("owner");
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
        if (!/^[a-z0-9_]{1,15}$/.test(owner || "") || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 1) fail(400, "账号或分页参数无效。");
        const rows = db.prepare("SELECT id, snapshot FROM own_posts WHERE owner = ? AND id < ? ORDER BY id DESC LIMIT ?").all(owner, before, limit + 1);
        return json(200, { owner, posts: rows.slice(0, limit).map(row => JSON.parse(row.snapshot)), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
      }
      if (req.method === "POST" && url.pathname === "/api/posts") {
        const post = validatePost(await readJson(req));
        const fingerprint = digest(JSON.stringify(post)).toString("hex");
        db.exec("BEGIN IMMEDIATE");
        let saved;
        let status = 201;
        try {
          saved = db.prepare("SELECT * FROM posts WHERE external_id = ?").get(post.externalId);
          if (saved) {
            if (saved.fingerprint !== fingerprint) fail(409, "externalId 已存在且内容不同，请为新帖子使用新的 externalId。");
            status = 200;
          } else {
            const inserted = db.prepare("INSERT INTO posts (external_id, fingerprint, title, text, sources, created_at) VALUES (?, ?, ?, ?, ?, ?)")
              .run(post.externalId, fingerprint, post.title, post.text, JSON.stringify(post.sources), new Date().toISOString());
            const id = Number(inserted.lastInsertRowid);
            const insertImage = db.prepare("INSERT INTO images (post_id, position, alt, url, mime_type, data) VALUES (?, ?, ?, ?, ?, ?)");
            post.images.forEach((image, index) => insertImage.run(id, index, image.alt, image.url ?? null, image.mimeType ?? null,
              image.base64 ? Buffer.from(image.base64, "base64") : null));
            saved = db.prepare("SELECT * FROM posts WHERE id = ?").get(id);
          }
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        return json(status, { post: publicPost(saved) });
      }
      if (req.method === "GET" && url.pathname === "/api/posts") {
        const status = url.searchParams.get("status") ?? "pending";
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
        if (!["pending", "consumed", "all"].includes(status) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
            !Number.isSafeInteger(before) || before < 1) fail(400, "分页或状态参数无效。");
        const filter = status === "pending" ? "AND consumed_at IS NULL" : status === "consumed" ? "AND consumed_at IS NOT NULL" : "";
        const rows = db.prepare(`SELECT * FROM posts WHERE id < ? ${filter} ORDER BY id DESC LIMIT ?`).all(before, limit + 1);
        return json(200, { posts: rows.slice(0, limit).map(publicPost), nextCursor: rows.length > limit ? rows[limit - 1].id : null });
      }
      const consume = url.pathname.match(/^\/api\/posts\/([1-9]\d*)\/consume$/);
      if (req.method === "POST" && consume) {
        const input = await readJson(req);
        if (typeof input?.consumed !== "boolean") fail(400, "consumed 必须是布尔值。");
        const result = db.prepare("UPDATE posts SET consumed_at = CASE WHEN ? THEN COALESCE(consumed_at, ?) ELSE NULL END WHERE id = ?")
          .run(Number(input.consumed), new Date().toISOString(), consume[1]);
        if (!result.changes) fail(404, "帖子不存在。");
        return json(200, { post: publicPost(db.prepare("SELECT * FROM posts WHERE id = ?").get(consume[1])) });
      }
      const image = url.pathname.match(/^\/api\/posts\/([1-9]\d*)\/images\/([0-3])$/);
      if (req.method === "GET" && image) {
        const row = db.prepare("SELECT mime_type, data FROM images WHERE post_id = ? AND position = ?").get(image[1], image[2]);
        if (!row?.data) fail(404, "没有已上传的图片。");
        res.writeHead(200, { "Content-Type": row.mime_type, "Content-Length": row.data.length });
        return res.end(Buffer.from(row.data));
      }
      if (req.method === "GET" && url.pathname === "/api/friendly/batch") {
        const count = Math.min(Math.max(Number(url.searchParams.get("count") ?? 6), 1), 30);
        let rows = db.prepare("SELECT id, style, text FROM friendly_comments WHERE consumed = 0 ORDER BY RANDOM() LIMIT ?").all(count);
        if (rows.length < count) {
          db.prepare("UPDATE friendly_comments SET consumed = 0").run();
          rows = db.prepare("SELECT id, style, text FROM friendly_comments ORDER BY RANDOM() LIMIT ?").all(count);
        }
        return json(200, { comments: rows });
      }
      if (req.method === "POST" && url.pathname === "/api/friendly/consume") {
        const input = await readJson(req);
        const id = Number(input?.id);
        if (!Number.isSafeInteger(id) || id <= 0) fail(400, "评论 ID 无效。");
        const result = db.prepare("UPDATE friendly_comments SET consumed = 1 WHERE id = ?").run(id);
        if (!result.changes) fail(404, "评论不存在。");
        return json(200, { success: true, id });
      }
      if (req.method === "GET" && url.pathname === "/api/friendly/stats") {
        const total = db.prepare("SELECT count(*) as count FROM friendly_comments").get()?.count || 0;
        const pending = db.prepare("SELECT count(*) as count FROM friendly_comments WHERE consumed = 0").get()?.count || 0;
        return json(200, { total, pending, consumed: total - pending });
      }
      if (req.method === "POST" && url.pathname === "/api/friendly/batch-insert") {
        const input = await readJson(req);
        if (!Array.isArray(input?.comments) || !input.comments.length) fail(400, "comments 数组不能为空。");
        db.exec("BEGIN IMMEDIATE");
        try {
          const stmt = db.prepare("INSERT OR IGNORE INTO friendly_comments (style, text, created_at) VALUES (?, ?, ?)");
          const now = new Date().toISOString();
          let inserted = 0;
          for (const item of input.comments) {
            if (typeof item.text === "string" && item.text.trim()) {
              const res = stmt.run(item.style || "同频共鸣", item.text.trim(), now);
              if (res.changes) inserted++;
            }
          }
          db.exec("COMMIT");
          return json(200, { inserted });
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      }
      fail(404, "接口不存在。");
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        req.resume();
        json(error.status || 500, { error: error.status ? error.message : "服务器处理失败，请稍后重试。" });
      }
      if (!error.status) console.error("Post API error:", error.code || error.name);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on("close", () => db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const localOnly = process.argv.includes("--local") || !process.env.POSTS_API_TOKEN;
  const databasePath = localOnly ? resolve(dirname(fileURLToPath(import.meta.url)), "data/posts.sqlite") : process.env.DATABASE_PATH || "./data/posts.sqlite";
  const server = createPostServer({ token: process.env.POSTS_API_TOKEN, databasePath, localOnly });
  const port = localOnly ? 12345 : Number(process.env.PORT || 8787);
  const host = localOnly ? "127.0.0.1" : process.env.HOST || "127.0.0.1";
  server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，请检查本地服务是否已经启动。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Post API: http://${host}:${port}\nSQLite: ${resolve(databasePath)}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
}
