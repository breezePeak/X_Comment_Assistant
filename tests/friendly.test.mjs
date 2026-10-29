import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PRESET_COMMENTS, getPresetBatch } from "../extension/friendly-panel.js";

test("预置千条交友评论库体量、质量与五五分比例检查", () => {
  assert.ok(PRESET_COMMENTS.length >= 1000, `预置语料库数量必须不少于 1000 条，当前有 ${PRESET_COMMENTS.length} 条`);

  const seen = new Set();
  let poeticCount = 0;
  let vernacularCount = 0;

  for (const item of PRESET_COMMENTS) {
    assert.ok(item.text && typeof item.text === "string", "评论正文必须是非空字符串");
    assert.ok(item.text.length >= 25 && item.text.length <= 38, `评论长度必须在合理范围内 (25-38字，30字左右短句): ${item.text}`);
    assert.ok(!seen.has(item.text), `预置语料库不得有重复内容: ${item.text}`);
    seen.add(item.text);

    // 严禁生硬套话与营销引流词
    assert.ok(!/求互关|求关注|求回关|加个微信|加好友/.test(item.text), `评论不得出现生硬套话: ${item.text}`);

    // 结尾必须表达交友期许
    assert.ok(/朋友|好友|推友|知己|同道|结识|交心|挚友|益友|道友|之友|良友|交个/.test(item.text), `评论结尾应自然表达交朋友/引为知己的期许: ${item.text}`);

    if (item.style === "诗词雅韵") {
      poeticCount++;
    } else if (item.style === "同频共鸣") {
      vernacularCount++;
    }
  }

  assert.ok(poeticCount >= 500, `诗词类应不少于 500 条，当前为 ${poeticCount}`);
  assert.ok(vernacularCount >= 500, `白话类应不少于 500 条，当前为 ${vernacularCount}`);

  // 比例接近 5:5
  const ratio = poeticCount / vernacularCount;
  assert.ok(ratio >= 0.8 && ratio <= 1.2, `诗词与白话比例应基本五五开，当前比例为 ${ratio}`);
});

test("批量提取数据库函数 getPresetBatch 正常洗牌并返回唯一条目", () => {
  const batch = getPresetBatch(6);
  assert.equal(batch.length, 6);
  const ids = new Set(batch.map(item => item.id));
  assert.equal(ids.size, 6);
});

test("界面结构包含独立的交友评论标签与控制按钮", () => {
  const html = fs.readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
  assert.match(html, /id="view-friendly"/, "必须包含交友评论切换按钮");
  assert.match(html, /id="friendly-view"/, "必须包含交友评论容器");
  assert.match(html, /id="friendly-generate"/, "必须包含获取新评论按钮");
  assert.match(html, /id="friendly-list"/, "必须包含评论列表容器");
  assert.match(html, /friendly-panel\.js/, "必须正确引用 friendly-panel.js 脚本");
});

test("视图路由器包含 friendly 视图切换", () => {
  const postsPanelJs = fs.readFileSync(new URL("../extension/posts-panel.js", import.meta.url), "utf8");
  assert.match(postsPanelJs, /"friendly"/, "views 数组必须包含 friendly");
});

test("SQLite 真实数据库 friendly_comments 表及服务端批次提取/消费接口", async t => {
  let sqliteModule;
  try {
    sqliteModule = await import("node:sqlite");
  } catch {
    t.skip("当前执行测试的 Node 环境不支持内置 node:sqlite (需要 Node 22.5+ 或 24+)");
    return;
  }
  const { DatabaseSync } = sqliteModule;
  const { createPostServer } = await import("../server/server.mjs");
  const { once } = await import("node:events");
  const { postServiceRequest } = await import("../extension/posts-api.js");

  const db = new DatabaseSync("server/data/posts.sqlite");
  const countRow = db.prepare("SELECT count(*) as count FROM friendly_comments").get();
  assert.ok(countRow.count >= 1000, `SQLite 数据库中必须包含至少 1000 条数据，当前有 ${countRow.count} 条`);

  const unconsumed = db.prepare("SELECT count(*) as count FROM friendly_comments WHERE consumed = 0").get();
  assert.ok(unconsumed.count >= 1000, "初始未消费评论应不少于 1000 条");
  db.close();

  // 测试服务端接口
  const server = createPostServer({ localOnly: true, databasePath: "server/data/posts.sqlite" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const batchRes = await postServiceRequest({ baseUrl }, "/api/friendly/batch?count=6");
    assert.equal(batchRes.comments.length, 6);
    assert.ok(batchRes.comments[0].text.length >= 25 && batchRes.comments[0].text.length <= 38);

    const consumeRes = await postServiceRequest({ baseUrl }, "/api/friendly/consume", {
      method: "POST",
      body: { id: batchRes.comments[0].id }
    });
    assert.equal(consumeRes.success, true);
    assert.equal(consumeRes.id, batchRes.comments[0].id);

    const statsRes = await postServiceRequest({ baseUrl }, "/api/friendly/stats");
    assert.ok(statsRes.total >= 1000);
    assert.ok(statsRes.consumed >= 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

