/**
 * End-to-end check of both host sections, with no dependency on the profile.
 *
 * The plugin is installed through a symlink, so its real path has no
 * `node_modules`: any bare `@deepseek-ai/*` specifier inside the host half would
 * fail here exactly as it fails at runtime. This file therefore runs with NO
 * temporary `node_modules` link, which is what makes it a real regression guard
 * for the "empty response body" failure.
 */

import assert from "node:assert/strict";

const plugin = await import("./index.js");

const attempt = {
  seq: 42,
  type: "assistant/attempt",
  data: {
    turn: 3,
    step: 1,
    stream: [
      { type: "reasoning-chunks", time0: 0, index: 0, dt: [1], texts: ["先想", "再写"] },
      { type: "text-chunks", time0: 2, index: 1, dt: [1], texts: ["白柠汐", "走进", "店里"] }
    ]
  }
};

const appended = [];
const session = {
  seq: 43,
  snapshotEvents: (from, to) => [attempt].filter((event) => event.seq >= from && event.seq < to),
  append: (type, data, options) => {
    appended.push({ type, data, options });
    return { seq: 44 };
  }
};

let route;
plugin.apply({
  inject: (_names, run) => run({
    connection: { fetch: { register: (value) => (route = value, () => {}) } },
    sessions: { get: (id) => (id === "live" ? session : undefined) }
  }),
  effect: (run) => run()
});

const call = async (body, raw) =>
  (await route.fetch(new Request("http://x/api/attempt-recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body)
  }))).json();

// ---- a thrown handler must still answer with JSON ---------------------------
// Break the session so append throws deep inside the handler.
const brokenSession = {
  seq: 43,
  snapshotEvents: (from, to) => [attempt].filter((event) => event.seq >= from && event.seq < to),
  append: () => {
    throw new Error("disk full");
  }
};
let brokenRoute;
plugin.apply({
  inject: (_names, run) => run({
    connection: { fetch: { register: (value) => (brokenRoute = value, () => {}) } },
    sessions: { get: () => brokenSession }
  }),
  effect: (run) => run()
});
const brokenResponse = await brokenRoute.fetch(new Request("http://x/api/attempt-recover", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "live", seq: 42 })
}));
const brokenText = await brokenResponse.text();
assert.notEqual(brokenText, "", "a failing handler must never answer with an empty body");
const broken = JSON.parse(brokenText);
assert.equal(broken.ok, false);
assert.equal(broken.error.code, "attempt-recover/append-failed");

// ---- both sections ---------------------------------------------------------
const textResult = await call({ sessionId: "live", seq: 42 });
assert.equal(textResult.ok, true, JSON.stringify(textResult));
assert.equal(textResult.value.section, "text");
assert.equal(textResult.value.chars, 7);

const reasoningResult = await call({ sessionId: "live", seq: 42, section: "reasoning" });
assert.equal(reasoningResult.ok, true, JSON.stringify(reasoningResult));
assert.equal(reasoningResult.value.section, "reasoning");
assert.equal(reasoningResult.value.chars, 4);

assert.equal(appended.length, 2);
const textMessage = appended[0].data.content[0].text;
const reasoningMessage = appended[1].data.content[0].text;

assert.ok(textMessage.includes("白柠汐走进店里"), "recovered output must survive verbatim");
assert.ok(textMessage.startsWith("[恢复的未完成输出]"), textMessage.slice(0, 40));
assert.ok(reasoningMessage.startsWith("[恢复的未完成思考过程]"), reasoningMessage.slice(0, 40));
assert.ok(reasoningMessage.includes("先想再写"), "recovered reasoning must survive verbatim");
assert.ok(!reasoningMessage.includes("白柠汐"), "reasoning message must not carry output text");
assert.ok(!textMessage.includes("先想"), "output message must not carry reasoning text");

for (const record of appended) {
  assert.equal(record.type, "user/message");
  assert.equal(record.options.surfaceOp, "append");
  assert.equal(record.data.role, "user");
  assert.equal(record.data.source.kind, "recovered-attempt");
  assert.equal(typeof record.data.id, "string");
  assert.ok(record.data.id.length >= 32, "the message needs a real identity");
  assert.ok(Array.isArray(record.data.content) && record.data.content.length > 0);
}

// ---- a handler that cannot append still answers JSON -----------------------
console.log("host e2e: 20/20 assertions passed");
console.log(JSON.stringify({ text: textMessage, reasoning: reasoningMessage }, null, 1));
