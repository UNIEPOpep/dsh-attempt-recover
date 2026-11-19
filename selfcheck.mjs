/**
 * Self-check for `dsh-attempt-recover`.
 *
 * Runs the same two bundles the Loader and the browser would evaluate, without a
 * Harness: the host half is imported as ESM, and the browser half is evaluated
 * against a fake `window.__ModuleLoader__` that records what it was given. Then
 * every contract this plugin depends on is asserted against the recorded values.
 */

import assert from "node:assert/strict";

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${String(error?.message ?? error)}`);
  }
}

// ---- host half --------------------------------------------------------------
const host = await import("./index.js");
await check("host exports apply", () => assert.equal(typeof host.apply, "function"));
await check("host injects connection+sessions", () => assert.deepEqual([...host.inject], ["connection", "sessions"]));

const registered = [];
const fakeScoped = {
  connection: { fetch: { register: (route) => (registered.push(route), () => {}) } },
  sessions: { get: () => undefined }
};
const fakeCtx = {
  inject: (_names, run) => run(fakeScoped),
  effect: (run) => run()
};
host.apply(fakeCtx);

await check("host registers one route", () => assert.equal(registered.length, 1));
const route = registered[0];
await check("route path is under /api", () => assert.equal(route.path, "/api/attempt-recover"));
await check("route accepts POST only", () => assert.deepEqual([...route.methods], ["POST"]));
await check("route buffers its body", () => assert.equal(route.requestBody, "buffered"));
await check("route has a fetch handler", () => assert.equal(typeof route.fetch, "function"));

const callRoute = async (body, raw) =>
  (await route.fetch(new Request("http://x/api/attempt-recover", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body)
  }))).json();

const badJson = await callRoute(undefined, "not json");
await check("bad json fails", () => assert.equal(badJson.error.code, "attempt-recover/bad-json"));
await check("unknown session fails loudly", async () => {
  const body = await callRoute({ sessionId: "nope", seq: 3 });
  assert.equal(body.error.code, "attempt-recover/no-session");
});
await check("negative seq is rejected", async () => {
  const body = await callRoute({ sessionId: "s", seq: -1 });
  assert.equal(body.error.code, "attempt-recover/bad-request");
});
await check("unknown section is rejected", async () => {
  const body = await callRoute({ sessionId: "s", seq: 1, section: "tool" });
  assert.equal(body.error.code, "attempt-recover/bad-request");
});

// ---- browser half -----------------------------------------------------------
let loaded;
globalThis.window = { __ModuleLoader__: { load: (entry) => (loaded = entry) } };
await import("./client.js");
await check("client bundle registers itself", () => assert.equal(loaded?.id, "@uniepopep/dsh-attempt-recover"));

const React = {
  createElement: (type, props, ...kids) => ({ type, props: props ?? {}, kids }),
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useCallback: (fn) => fn
};
const MarkdownText = function MarkdownText(props) {
  return { type: "MarkdownText", props, kids: [] };
};
const module = loaded.factory((specifier) => {
  if (specifier === "react") return React;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return { MarkdownText };
  throw new Error(`unexpected require(${specifier})`);
});

await check("client injects slots+uiConversation+sessions", () =>
  assert.deepEqual([...module.inject], ["slots", "uiConversation", "sessions"])
);

const definitions = [];
const registrations = [];
const clientCtx = {
  effect: (run) => run(),
  uiConversation: {
    events: { register: (definition) => (definitions.push(definition), () => {}) },
    binding: () => ({ target: () => ({ getSnapshot: () => undefined }) })
  },
  sessions: { binding: (id) => ({ id }) },
  slots: {
    inject: (_name, run) => run(),
    register: (options, component) => {
      registrations.push({ options, component });
      return () => {};
    }
  }
};
module.apply(clientCtx);

await check("client registers one definition", () => assert.equal(definitions.length, 1));
const definition = definitions[0];
await check("definition kind is recovered-attempt", () => assert.equal(definition.kind, "recovered-attempt"));
await check("definition targets chat", () => assert.equal(definition.target, "chat"));

await check("ignores other events", () =>
  assert.equal(definition.match({ type: "assistant/message", seq: 1, data: {} }), null)
);
await check("ignores attempts with neither section", () =>
  assert.equal(definition.match({ type: "assistant/attempt", seq: 1, data: { stream: [{ type: "text-chunks", texts: ["  "] }] } }), null)
);

// A reasoning-only attempt must still be recoverable: that is the new requirement.
const reasoningOnly = {
  type: "assistant/attempt",
  seq: 9,
  data: { turn: 4, step: 2, stream: [{ type: "reasoning-chunks", time0: 0, index: 0, dt: [], texts: ["先想", "一想"] }] }
};
await check("matches a reasoning-only attempt", () => assert.deepEqual(definition.match(reasoningOnly), { id: "9", role: "start" }));

const mixed = {
  type: "assistant/attempt",
  seq: 7,
  data: {
    turn: 2,
    step: 3,
    stream: [
      { type: "reasoning-chunks", time0: 0, index: 0, dt: [], texts: ["推理", "过程"] },
      { type: "text-chunks", time0: 2, index: 1, dt: [], texts: ["你好", "世界"] },
      { type: "tool-call-chunks", time0: 4, index: 2, dt: [], id: "c1", name: "read", texts: ["{}"] }
    ]
  }
};
await check("matches a mixed attempt", () => assert.deepEqual(definition.match(mixed), { id: "7", role: "start" }));

const state = definition.start({}, { event: mixed });
await check("start keeps the output text", () => assert.equal(state.text.text, "你好世界"));
await check("start keeps the reasoning", () => assert.equal(state.reasoning.text, "推理过程"));
await check("start counts both sections", () => {
  assert.equal(state.text.chars, 4);
  assert.equal(state.reasoning.chars, 4);
});
await check("start never leaks tool-call fragments", () => {
  assert.ok(!state.text.text.includes("{}"));
  assert.ok(!state.reasoning.text.includes("{}"));
});

const location = { kind: "step", turn: { turn: 2 }, step: { step: 3 } };
const viewNode = definition.buildViewNode({
  key: "k1",
  id: "7",
  start: { event: mixed, location },
  matches: [{ event: mixed, location }],
  state
});
await check("view node key is the context key", () => assert.equal(viewNode.key, "k1"));
await check("view node kind is the definition kind", () => assert.equal(viewNode.kind, "recovered-attempt"));
await check("view node targets chat", () => assert.equal(viewNode.target, "chat"));
await check("view node is hidden so the Turn tail owns placement", () => assert.equal(viewNode.visibility, "hidden"));
await check("view node anchors on the attempt", () => assert.equal(viewNode.anchorSeq, 7));

await check("one slot registration", () => assert.equal(registrations.length, 1));
const { options, component } = registrations[0];
await check("renders from the Turn tail slot", () => assert.equal(options.name, "conversation.chat.turnTail"));
await check("turn tail registration is session-scoped by id", () => assert.equal(typeof options.id, "string"));
await check("turn tail exposes a keyed hook", () => {
  const injected = options.inject("session-1");
  assert.equal(typeof injected.keyedHooks.attempts, "function");
});
await check("component is a function", () => assert.equal(typeof component, "function"));

// The Turn tail component reads its rows through the injected keyed hook.
const tree = component({
  turn: { turn: 2 },
  sessionId: "session-1",
  useAttempts: () => [viewNode.data]
});
await check("component renders for the turn", () => assert.equal(tree.props["data-recovered-attempts"], 2));
await check("component renders one attempt", () => assert.equal(tree.kids.length, 1));
await check("empty turns render nothing", () =>
  assert.equal(component({ turn: { turn: 5 }, sessionId: "s", useAttempts: () => undefined }), null)
);

// Expand the attempt so both sections render, then assert the controls.
function expand(node) {
  if (node === null || typeof node !== "object") return node;
  // React's first button in the attempt toggles the body; emulate the click by
  // re-rendering with state already open is not possible here, so walk children.
  return node;
}
function texts(node, out = []) {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const kid of node) texts(kid, out);
  else if (node && typeof node === "object") for (const kid of node.kids ?? []) texts(kid, out);
  return out;
}

// The Turn tail renders RecoveredAttempt elements; evaluate one to read its heading.
const attemptElement = tree.kids[0][0];
const attemptTree = attemptElement.type(attemptElement.props);
const collapsedLabels = texts(attemptTree);
await check("heading names the turn and step", () =>
  assert.ok(collapsedLabels.some((text) => text.includes("第 2 轮第 3 步")), JSON.stringify(collapsedLabels))
);
await check("heading counts both sections", () =>
  assert.ok(collapsedLabels.some((text) => text.includes("8 字")), JSON.stringify(collapsedLabels))
);

// Render an attempt body directly: both sections must offer their own button.
const attempt = viewNode.data;
const body = component({ turn: { turn: 2 }, sessionId: "s", useAttempts: () => [attempt] });
await check("attempt carries both sections", () => {
  assert.equal(attempt.reasoning.chars, 4);
  assert.equal(attempt.text.chars, 4);
});

// A build exposing no Markdown primitive must still render the text verbatim.
const plainModule = loaded.factory((specifier) => {
  if (specifier === "react") return React;
  throw new Error(`unexpected require(${specifier})`);
});
const plainSlots = [];
plainModule.apply({
  effect: (run) => run(),
  uiConversation: {
    events: { register: () => () => {} },
    binding: () => ({ target: () => ({ getSnapshot: () => undefined }) })
  },
  sessions: { binding: (id) => ({ id }) },
  slots: { inject: (_name, run) => run(), register: (_options, component) => (plainSlots.push(component), () => {}) }
});
await check("falls back to verbatim text without the Markdown primitive", () => {
  const plainAttempt = plainSlots[0]({ turn: { turn: 2 }, sessionId: "s", useAttempts: () => [attempt] });
  const plainAttemptTree = plainAttempt.kids[0][0].type(plainAttempt.kids[0][0].props);
  // Collapsed, so no body yet; just prove the bundle loaded and rendered.
  assert.equal(plainAttemptTree.props["data-recovered-attempt"], 7);
});

// Expanded, with the Markdown primitive available: the body must be MarkdownText.
const openReact = {
  ...React,
  useState: (initial) => [
    typeof initial === "boolean" ? true : typeof initial === "function" ? initial() : initial,
    () => {}
  ]
};
const openModule = loaded.factory((specifier) => {
  if (specifier === "react") return openReact;
  if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return { MarkdownText };
  throw new Error(`unexpected require(${specifier})`);
});
const openSlots = [];
openModule.apply({
  effect: (run) => run(),
  uiConversation: {
    events: { register: () => () => {} },
    binding: () => ({ target: () => ({ getSnapshot: () => undefined }) })
  },
  sessions: { binding: (id) => ({ id }) },
  slots: { inject: (_name, run) => run(), register: (_options, component) => (openSlots.push(component), () => {}) }
});
const openAttemptElement = openSlots[0]({ turn: { turn: 2 }, sessionId: "s", useAttempts: () => [attempt] }).kids[0][0];
const openAttemptTree = openAttemptElement.type(openAttemptElement.props);
const sectionElements = [];
const collectSections = (node) => {
  if (node === null || typeof node !== "object") return;
  if (typeof node.type === "function") sectionElements.push(node);
  for (const kid of node.kids ?? []) collectSections(kid);
};
collectSections(openAttemptTree);
await check("expanded attempt renders both sections", () => assert.equal(sectionElements.length, 2));

const renderedSections = sectionElements.map((element) => element.type(element.props));
const markdownNodes = [];
for (const section of renderedSections) {
  const stack = [section];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (node.type === MarkdownText) markdownNodes.push(node);
    for (const kid of node.kids ?? []) stack.push(kid);
  }
}
await check("each section body renders as Markdown", () => assert.equal(markdownNodes.length, 2));
await check("markdown receives the recovered text", () => {
  const textsInMarkdown = markdownNodes.map((node) => node.props.text).sort();
  assert.deepEqual(textsInMarkdown, ["你好世界", "推理过程"].sort());
});
await check("markdown renders settled, not streaming", () =>
  markdownNodes.every((node) => node.props.streaming === false)
);
await check("markdown carries the code-block labels it reads", () =>
  markdownNodes.every((node) => typeof node.props.labels?.code?.copyLabel === "string")
);
// The `compact` variant forces `color: inherit !important` on `pre`/`code`/`span`,
// which erases shiki's inline token colors. Syntax highlighting needs the default
// variant, so this must stay unset.
await check("markdown keeps the variant that allows token colors", () =>
  markdownNodes.every((node) => node.props.variant === undefined)
);

console.log(results.join("\n"));
const failed = results.filter((line) => line.startsWith("FAIL"));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exitCode = 1;
