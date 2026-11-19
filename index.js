/**
 * Host half of `dsh-attempt-recover`.
 *
 * The Harness settles a failed or aborted model request as an `assistant/attempt`
 * event. That event keeps the complete stream, but it has no surface projection
 * and no Chat node reads it, so the text the model already produced disappears
 * from the conversation. This half exposes one authenticated exact Fetch route
 * that appends that recovered text to the model-visible surface as a user
 * message, on demand.
 *
 * This module deliberately imports nothing but Node builtins: the plugin is
 * installed through a symlink into the profile, so its real path has no
 * `node_modules` of its own and a bare `@deepseek-ai/*` specifier would fail at
 * runtime.
 *
 * @module dsh-attempt-recover
 */

import { randomUUID } from "node:crypto";

/** Exact path mounted under the Connection `/api` prefix. */
const ROUTE = "/api/attempt-recover";

/** Services this plugin needs before it can register anything. */
export const inject = ["connection", "sessions"];

/** The two stream sections this plugin can re-admit independently. */
const SECTIONS = new Set(["text", "reasoning"]);

/**
 * Build a failed result.
 *
 * @param code - stable machine code.
 * @param message - human explanation.
 * @returns the failure envelope.
 */
function failure(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Answer one request with a JSON body.
 *
 * @param body - serializable payload.
 * @param status - HTTP status code.
 * @returns the fetch Response.
 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

/**
 * Register the recovery route.
 *
 * @param ctx - owning Host plugin context.
 */
export function apply(ctx) {
  ctx.inject(["connection", "sessions"], (scoped) => {
    const lifetime = new AbortController();
    ctx.effect(() => () => lifetime.abort(), "dsh-attempt-recover: route lifetime");

    scoped.connection.fetch.register({
      path: ROUTE,
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          let payload;
          try {
            payload = await request.json();
          } catch {
            return json(failure("attempt-recover/bad-json", "body is not JSON"), 400);
          }
          const result = await recover(scoped, payload?.sessionId, payload?.seq, payload?.section, lifetime.signal);
          return json(result, result.ok === true ? 200 : 400);
        } catch (error) {
          // Never let a throw escape: the bridge writes no body for a rejected
          // handler, and the browser then reports "Unexpected end of JSON input".
          return json(failure("attempt-recover/failed", String(error?.message ?? error)), 500);
        }
      }
    });
  });
}

/**
 * Append one failed attempt's section to the model-visible surface.
 *
 * @param scoped - context owning `sessions`.
 * @param sessionId - live session id.
 * @param seq - sequence of the `assistant/attempt` event.
 * @param section - `"text"` (default) or `"reasoning"`.
 * @param signal - aborts the work when the plugin unloads.
 * @returns the result envelope.
 */
async function recover(scoped, sessionId, seq, section, signal) {
  const which = section ?? "text";
  if (typeof sessionId !== "string" || sessionId === "") return failure("attempt-recover/bad-request", "sessionId is required");
  if (!Number.isSafeInteger(seq) || seq < 0) return failure("attempt-recover/bad-request", "seq must be a non-negative integer");
  if (!SECTIONS.has(which)) return failure("attempt-recover/bad-request", `section must be one of ${[...SECTIONS].join(", ")}`);
  signal.throwIfAborted();

  const session = scoped.sessions.get(sessionId);
  if (session === undefined) return failure("attempt-recover/no-session", `session ${sessionId} is not live`);

  const event = session.snapshotEvents(0, session.seq).find((candidate) => candidate.seq === seq);
  if (event === undefined || event.type !== "assistant/attempt") {
    return failure("attempt-recover/no-attempt", `no assistant/attempt at seq ${seq}`);
  }

  const stream = event.data.stream;
  const text = which === "reasoning" ? joinReasoningStream(stream) : joinAssistantStreamText(stream);
  if (text.trim() === "") return failure("attempt-recover/empty", `this attempt produced no ${which}`);
  signal.throwIfAborted();

  const turn = event.data.turn;
  const step = event.data.step;
  const message = {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text: banner(which, turn, step, text) }],
    source: { kind: "recovered-attempt" }
  };
  let appended;
  try {
    appended = session.append("user/message", message, { surfaceOp: "append" });
  } catch (error) {
    return failure("attempt-recover/append-failed", String(error?.message ?? error));
  }
  return { ok: true, value: { seq: appended.seq, chars: text.length, turn, step, section: which } };
}

/**
 * Join the output fragments of one compact stream.
 *
 * Mirrors `joinAssistantStreamText` from `@deepseek-ai/dsh-llm` without
 * importing it: `text-chunks` records carry joined fragments, bare `chunk`
 * records carry single deltas, and reasoning and Tool-call fragments are
 * excluded.
 *
 * @param stream - compact records from one durable Assistant settlement.
 * @returns the joined output, empty when the attempt produced none.
 */
function joinAssistantStreamText(stream) {
  const parts = [];
  for (const record of stream) {
    if (record === null || typeof record !== "object") continue;
    if (record.type === "text-chunks" && Array.isArray(record.texts)) parts.push(record.texts.join(""));
    else if (record.type === "chunk" && record.chunk?.type === "text-delta" && typeof record.chunk.text === "string") parts.push(record.chunk.text);
  }
  return parts.join("");
}

/**
 * Join the reasoning fragments of one compact stream.
 *
 * Mirrors the shape `joinAssistantStreamText` uses for output, but reads only
 * the `reasoning-chunks` records and `reasoning-delta` chunks.
 *
 * @param stream - compact records from one durable Assistant settlement.
 * @returns the joined reasoning, empty when the attempt produced none.
 */
function joinReasoningStream(stream) {
  const parts = [];
  for (const record of stream) {
    if (record === null || typeof record !== "object") continue;
    if (record.type === "reasoning-chunks" && Array.isArray(record.texts)) parts.push(record.texts.join(""));
    else if (record.type === "chunk" && record.chunk?.type === "reasoning-delta" && typeof record.chunk.text === "string") parts.push(record.chunk.text);
  }
  return parts.join("");
}

/**
 * Frame the recovered fragment so the model treats it as its own interrupted work.
 *
 * @param section - which part of the attempt this is.
 * @param turn - Turn the attempt belonged to.
 * @param step - Step the attempt belonged to.
 * @param text - Recovered text.
 * @returns the user-visible message text.
 */
function banner(section, turn, step, text) {
  const what = section === "reasoning" ? "思考过程" : "输出";
  return [
    `[恢复的未完成${what}]`,
    `下面这段内容是你上一次回复中途失败前已经生成的${what}、但没有进入对话历史的部分（原始位置：第 ${turn} 轮第 ${step} 步）。`,
    section === "reasoning"
      ? "它是你当时的思考，不是最终答案。请把它当作你已经想过的内容继续，不要重复。"
      : "它是残缺的，可能停在半句话上。请把它当作你已经写过的内容继续，不要重复已经写好的部分。",
    "",
    "-----",
    text,
    "-----"
  ].join("\n");
}
