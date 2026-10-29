import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { pathToFileURL } from "node:url";
import { createPostServer } from "../server/server.mjs";
import { LOCAL_POST_SERVICE, imageSource, postServiceRequest, validatePostService } from "../extension/posts-api.js";

test("本机服务免 Token，只接受回环地址与扩展请求，插件默认地址可直接使用", async () => {
  const server = createPostServer({ localOnly: true, databasePath: ":memory:" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(validatePostService(), LOCAL_POST_SERVICE);
    assert.deepEqual(validatePostService({ baseUrl }), { baseUrl, token: "" });
    assert.throws(() => validatePostService({ baseUrl: "http://remote.test:12345", token: "" }), /Token/);
    const health = await (await fetch(baseUrl + "/healthz")).json();
    assert.equal(health.localOnly, true);
    assert.equal(health.service, "x-comment-assistant");
    const response = await postServiceRequest({ baseUrl }, "/api/posts");
    assert.deepEqual(response.posts, []);
    const created = await postServiceRequest({ baseUrl }, "/api/posts", { method: "POST", body: sample });
    assert.equal(created.post.text, sample.text);
    for (const headers of [{ Origin: "https://evil.test" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
      assert.equal((await fetch(baseUrl + "/api/posts", { headers })).status, 403, JSON.stringify(headers));
    }
    const rebound = await new Promise((resolve, reject) => {
      const req = httpRequest(baseUrl + "/api/posts", { headers: { Host: `evil.test:${server.address().port}` } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(rebound, 403, "拒绝 DNS rebinding 的非本机 Host");
    assert.equal((await fetch(baseUrl + "/api/posts", { headers: { Origin: "chrome-extension://" + "a".repeat(32), "Sec-Fetch-Site": "cross-site" } })).status, 200);
    await postServiceRequest({ baseUrl }, "/api/posts", {}, async (_, options) => {
      assert.equal(options.headers.Authorization, undefined);
      return new Response('{"posts":[]}');
    });
  } finally { await close(server); }
});

test("服务端可独立运行，校验与合并逻辑和插件一致", async () => {
  const serverModel = await readFile(new URL("../server/analytics-data.mjs", import.meta.url), "utf8");
  const extensionModel = await readFile(new URL("../extension/analytics-data.js", import.meta.url), "utf8");
  assert.equal(serverModel.trim(), extensionModel.split("export function interactionRate")[0].trim());
  const dir = await mkdtemp(join(tmpdir(), "x-standalone-server-"));
  let server;
  try {
    for (const file of ["server.mjs", "analytics-data.mjs"]) await copyFile(new URL(`../server/${file}`, import.meta.url), join(dir, file));
    const standalone = await import(pathToFileURL(join(dir, "server.mjs")).href);
    server = standalone.createPostServer({ token, databasePath: ":memory:" });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json(), { ok: true });
  } finally {
    if (server) await close(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("本人帖子接口：鉴权、账号隔离、最新互动覆盖、旧快照保护、分页与数据库持久化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "x-analytics-test-"));
  const databasePath = join(dir, "posts.sqlite");
  let running = await listen(databasePath);
  const post = {
    id: "1234567890123456789", owner: "me", url: "https://x.com/me/status/1234567890123456789", text: "本人正文", quote: "引用文字",
    publishedAt: "2026-10-24T01:00:00.000Z", collectedAt: "2026-10-25T01:00:00.000Z",
    isQuote: true, hasImage: false, hasVideo: false, textMayBeTruncated: false,
    metrics: { views: 100, likes: 5, replies: 2, reposts: 3, bookmarks: null },
    metricLabels: { views: "100", likes: "5", replies: "2", reposts: "3", bookmarks: "" }
  };
  const request = (path, body, auth = token) => fetch(running.baseUrl + path, {
    method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const submit = posts => request("/api/analytics/posts", { owner: "me", posts });
  const list = async (query = "owner=me") => (await request(`/api/analytics/posts?${query}`)).json();
  try {
    assert.equal((await request("/api/analytics/posts?owner=me", undefined, "bad")).status, 401);
    assert.equal((await request("/api/analytics/posts", { owner: "me", posts: [post] }, "bad")).status, 401);
    assert.deepEqual(await (await submit([post])).json(), { accepted: 1 });
    const updated = { ...post, collectedAt: "2026-10-25T02:00:00.000Z", metrics: { ...post.metrics, likes: 9 } };
    await submit([updated]);
    await submit([post]);
    assert.equal((await list()).posts[0].metrics.likes, 9);
    await submit([{ ...updated, collectedAt: "2026-10-25T03:00:00.000Z" }]);
    assert.equal((await list()).posts[0].collectedAt, updated.collectedAt, "未变化数据不修改采集时间");
    assert.deepEqual((await list("owner=someone")).posts, []);
    assert.equal((await submit([{ ...post, owner: "someone" }])).status, 400);
    assert.equal((await submit([post, { ...post, id: "2", metrics: { ...post.metrics, likes: -1 } }])).status, 400);
    assert.equal((await list()).posts.length, 1, "整批校验失败时不能留下半批记录");
    await submit([{ ...post, id: "2", url: "https://x.com/me/status/2" }]);
    const page = await list("owner=me&limit=1");
    assert.equal(page.posts.length, 1);
    assert(page.nextCursor);
    const next = await list(`owner=me&limit=1&before=${page.nextCursor}`);
    assert.equal(next.posts[0].id, post.id);
    assert.equal(next.nextCursor, null);
    for (const query of ["owner=../me", "owner=me&limit=101", "owner=me&before=-1"]) assert.equal((await request(`/api/analytics/posts?${query}`)).status, 400);
    await close(running.server);
    running = await listen(databasePath);
    assert.equal((await list()).posts.length, 2);
    assert.equal((await list()).posts.find(item => item.id === post.id).metrics.likes, 9);
  } finally { await close(running.server); await rm(dir, { recursive: true, force: true }); }
});

const token = "a-test-token-that-is-at-least-32-characters";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9sAAAAASUVORK5CYII=";
const sample = { externalId: "2026-10-19-ai-01", title: "AI 热点", text: "可供人工审核的热点正文。",
  images: [{ mimeType: "image/png", base64: png, alt: "配图" }, { url: "https://images.example.com/a.png", alt: "外部配图" }],
  sources: [{ title: "来源", url: "https://example.com/news" }] };

async function listen(databasePath) {
  const server = createPostServer({ token, databasePath });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

test("原创曝光接口：每天一次、跨日变化、账号隔离、鉴权与重启保留", async () => {
  const dir = await mkdtemp(join(tmpdir(), "x-impressions-test-"));
  const databasePath = join(dir, "posts.sqlite");
  let running = await listen(databasePath);
  const send = (body, auth = token) => fetch(running.baseUrl + "/api/analytics/impressions", {
    method: "POST", headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  const list = owner => postServiceRequest({ baseUrl: running.baseUrl, token }, `/api/analytics/impressions?owner=${owner}`);
  const row = { owner: "me", value: 23600, raw: "23.6K", collectedAt: "2026-10-29T02:00:00Z" };
  try {
    assert.equal((await send(row, "bad")).status, 401);
    assert.equal((await send({ ...row, value: -1 })).status, 400);
    assert.deepEqual(await postServiceRequest({ baseUrl: running.baseUrl, token }, "/api/analytics/impressions", { method: "POST", body: row }), { accepted: 1 });
    await send({ ...row, value: 24000, raw: "24K", collectedAt: "2026-10-29T03:00:00Z" });
    await send({ ...row, value: 24000, collectedAt: "2026-10-30T02:00:00Z" });
    await send({ ...row, value: 23000, raw: "23K", collectedAt: "2026-10-31T02:00:00Z" });
    await send(row);
    assert.deepEqual((await list("me")).impressions.map(row => [row.date, row.value]), [["2026-10-31", 23000], ["2026-10-29", 24000]]);
    const manual = { ...row, date: "2026-10-29", value: 26000, raw: "26000", source: "manual", collectedAt: "2026-11-01T02:00:00Z" };
    await send(manual);
    await send({ ...manual, value: 27000, collectedAt: "2026-11-01T03:00:00Z" });
    await send(manual);
    assert.equal((await list("me")).impressions[1].value, 27000, "历史日期修正与旧快照保护");
    assert.deepEqual((await list("other")).impressions, []);
    await close(running.server);
    running = await listen(databasePath);
    assert.equal((await list("me")).impressions.length, 2);
  } finally { await close(running.server); await rm(dir, { recursive: true, force: true }); }
});

test("鉴权、入库、图片读取、消费恢复、分页与重启持久化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "x-posts-test-"));
  const databasePath = join(dir, "posts.sqlite");
  let running = await listen(databasePath);
  const request = async (path, method = "GET", body, authorization = `Bearer ${token}`) => fetch(running.baseUrl + path, {
    method, headers: { Authorization: authorization, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  try {
    for (const [path, method, body] of [["/api/posts", "GET"], ["/api/posts", "POST", sample], ["/api/posts/1/consume", "POST", { consumed: true }], ["/api/posts/1/images/0", "GET"]]) {
      assert.equal((await request(path, method, body, "")).status, 401);
      assert.equal((await request(path, method, body, "Bearer wrong")).status, 401);
    }
    assert.deepEqual(await (await request("/healthz", "GET", undefined, "")).json(), { ok: true });
    assert.deepEqual((await (await request("/api/posts")).json()).posts, []);
    const created = await request("/api/posts", "POST", sample);
    assert.equal(created.status, 201);
    const { post } = await created.json();
    assert.equal(post.images[0].path, `/api/posts/${post.id}/images/0`);
    assert.equal(post.images[1].url, sample.images[1].url);
    assert.equal(post.images[0].base64, undefined);
    const image = await request(post.images[0].path);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, "base64"));
    assert.equal((await request(`/api/posts/${post.id}/images/1`)).status, 404);
    const retries = await Promise.all(Array.from({ length: 3 }, () => request("/api/posts", "POST", sample)));
    assert(retries.every(response => response.status === 200));
    assert.equal((await (await request("/api/posts")).json()).posts.length, 1);
    assert.equal((await request("/api/posts", "POST", { ...sample, text: "改变了的内容" })).status, 409);
    const consumed = await (await request(`/api/posts/${post.id}/consume`, "POST", { consumed: true })).json();
    assert(consumed.post.consumedAt);
    assert.equal((await (await request(`/api/posts/${post.id}/consume`, "POST", { consumed: true })).json()).post.consumedAt, consumed.post.consumedAt);
    assert.equal((await (await request("/api/posts", "POST", sample)).json()).post.consumedAt, consumed.post.consumedAt);
    assert.equal((await (await request("/api/posts")).json()).posts.length, 0);
    assert.equal((await (await request("/api/posts?status=consumed")).json()).posts.length, 1);
    await close(running.server);
    running = await listen(databasePath);
    assert.equal((await (await request("/api/posts?status=all")).json()).posts[0].consumedAt, consumed.post.consumedAt);
    assert.deepEqual(Buffer.from(await (await request(post.images[0].path)).arrayBuffer()), Buffer.from(png, "base64"));
    assert.equal((await request(`/api/posts/${post.id}/consume`, "POST", { consumed: false })).status, 200);
    assert.equal((await (await request("/api/posts")).json()).posts.length, 1);
    await request("/api/posts", "POST", { ...sample, externalId: "second" });
    const first = await (await request("/api/posts?limit=1")).json();
    assert.equal(first.posts.length, 1);
    const next = await (await request(`/api/posts?limit=1&before=${first.nextCursor}`)).json();
    assert.equal(next.posts[0].id, post.id);
    assert.equal(next.nextCursor, null);
    for (const query of ["limit=0", "limit=51", "limit=1.5", "before=-1", "status=invalid"]) assert.equal((await request(`/api/posts?${query}`)).status, 400);
    assert.equal((await request("/api/posts/999/consume", "POST", { consumed: true })).status, 404);
    assert.equal((await request(`/api/posts/${post.id}/consume`, "POST", { consumed: "true" })).status, 400);
  } finally { await close(running.server); await rm(dir, { recursive: true, force: true }); }
});

test("拒绝非法图文、畸形 JSON、过大请求和错误类型，不留下半条帖子", async () => {
  const { server, baseUrl } = await listen(":memory:");
  const submit = (body, type = "application/json") => fetch(baseUrl + "/api/posts", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": type }, body });
  try {
    for (const body of [null, [], {}, { ...sample, externalId: "" }, { ...sample, text: " " }, { ...sample, images: [] },
      { ...sample, images: Array(5).fill(sample.images[0]) }, { ...sample, sources: [{}] },
      ...["javascript:alert(1)", "http://example.com/image.png", "https://user:pass@example.com/a.png"].map(url => ({ ...sample, images: [{ url }] })),
      { ...sample, images: [{ url: "https://example.com/a.png", base64: png }] },
      { ...sample, images: [{ mimeType: "image/svg+xml", base64: png }] },
      { ...sample, images: [{ mimeType: "image/png", base64: Buffer.from("not an image").toString("base64") }] },
      { ...sample, images: [{ mimeType: "image/png", base64: "not base64 !" }] }]) {
      assert.equal((await submit(JSON.stringify(body))).status, 400, JSON.stringify(body));
    }
    assert.equal((await submit("{" )).status, 400);
    assert.equal((await submit(JSON.stringify(sample), "text/plain")).status, 415);
    assert.equal((await submit(" ".repeat(30 * 1024 * 1024 + 1))).status, 413);
    const large = Buffer.alloc(5 * 1024 * 1024);
    Buffer.from(png, "base64").copy(large);
    assert.equal((await submit(JSON.stringify({ ...sample, images: [{ mimeType: "image/png", base64: large.toString("base64") }] }))).status, 201);
    const list = await postServiceRequest({ baseUrl, token }, "/api/posts");
    assert.equal(list.posts.length, 1);
  } finally { await close(server); }
});

test("扩展配置校验、密钥仅放请求头、禁止重定向、错误提示及图片地址隔离", async () => {
  for (const baseUrl of ["https://user:pass@example.com", "https://example.com?token=x", "javascript:alert(1)"]) {
    assert.throws(() => validatePostService({ baseUrl, token }));
  }
  assert.equal(validatePostService({ baseUrl: "http://203.0.113.10:12345/", token }).baseUrl, "http://203.0.113.10:12345");
  assert.throws(() => createPostServer({ token: "short", databasePath: ":memory:" }), /POSTS_API_TOKEN/);
  assert.throws(() => validatePostService({ baseUrl: "https://example.com", token: "short" }), /Token/);
  const config = { baseUrl: "https://example.com/posts-service/", token };
  await postServiceRequest(config, "/api/posts/1/consume", { method: "POST", body: { consumed: true } }, async (url, options) => {
    assert.equal(url, "https://example.com/posts-service/api/posts/1/consume");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.deepEqual(JSON.parse(options.body), { consumed: true });
    return new Response('{"post":{}}');
  });
  await assert.rejects(postServiceRequest(config, "https://evil.test", {}, () => assert.fail("unexpected fetch")), /路径/);
  for (const path of ["/api/analytics/impressions-other", "/api/analytics/impressions/../posts", "/api/analytics/impressions#fragment", "/api/analytics/other"]) {
    await assert.rejects(postServiceRequest(config, path, {}, () => assert.fail("unexpected fetch")), /路径/);
  }
  await assert.rejects(postServiceRequest(config, "/api/posts", {}, async () => new Response("{}", { status: 401 })), /Token 无效/);
  await assert.rejects(postServiceRequest(config, "/api/posts", {}, async () => new Response('{"error":"操作失败"}', { status: 500 })), /操作失败/);
  assert.deepEqual(imageSource({ path: "/api/posts/1/images/0" }, 1, 0), { path: "/api/posts/1/images/0" });
  assert.throws(() => imageSource({ path: "https://evil.test/" }, 1, 0));
  assert.throws(() => imageSource({ url: "javascript:alert(1)" }, 1, 0));
  assert.deepEqual(imageSource({ url: "https://images.example.com/a.png" }, 1, 0), { url: "https://images.example.com/a.png" });
});
