/**
 * Browser half of `dsh-attempt-recover`.
 *
 * A failed or aborted request is persisted as an `assistant/attempt` event. The
 * Harness keeps the whole stream there but no Chat node reads it, so the text the
 * model already produced vanishes from the transcript. This half turns every such
 * attempt into a collapsible block with a re-admission button per section, and
 * renders it from the Turn tail so it never lands inside the Turn's process
 * disclosure.
 *
 * @module dsh-attempt-recover/client
 */

window.__ModuleLoader__.load({
  id: "@uniepopep/dsh-attempt-recover",
  factory(require) {
    const React = require("react");
    const h = React.createElement;

    /**
     * The shell's Markdown primitive, when this build exposes it.
     *
     * Recovered output is model Markdown — headings, lists, fenced code — so it
     * must render through the same pipeline as a settled Assistant message.
     * A build without the primitive still shows the text verbatim.
     */
    let MarkdownText;
    try {
      ({ MarkdownText } = require("@deepseek-ai/dsh-client-ui-primitives"));
    } catch {
      MarkdownText = undefined;
    }

    /**
     * Labels the Markdown renderer reads for its code-block chrome and footnotes.
     *
     * Kept literal rather than routed through a locale namespace so this plugin
     * adds no service dependency of its own.
     */
    const MARKDOWN_LABELS = {
      code: {
        copyLabel: "复制",
        copiedLabel: "已复制",
        toolbarLabels: { codeLabel: "代码", wrapLabel: "自动换行", unwrapLabel: "取消换行" }
      },
      footnotes: "脚注"
    };

    const KIND = "recovered-attempt";
    const ROUTE = "/api/attempt-recover";
    const SLOT = "conversation.chat.turnTail";
    const NS = "dsh-attempt-recover";

    /**
     * Tighten the settled Markdown block for a fold without touching its colors.
     *
     * `MarkdownText`'s own `compact` variant is unusable here: it forces
     * `color: inherit !important` on `pre`/`code`/`span`, which erases the
     * `--shiki-*` token colors and leaves every code block monochrome. Scoping
     * the spacing ourselves keeps syntax highlighting intact.
     */
    const CSS = `
[data-recovered-body] :is(h1, h2, h3, h4, h5, h6) { margin: 10px 0 6px; }
[data-recovered-body] p { margin: 8px 0; }
[data-recovered-body] :is(ul, ol, blockquote) { margin: 6px 0; }
[data-recovered-body] li:not(:first-child) { margin-top: 2px; }
[data-recovered-body] li > p { margin: 4px 0; }
[data-recovered-body] hr { margin: 8px 0; }
[data-recovered-body] table { margin: 8px 0; }
[data-recovered-body] pre { margin: 6px 0; }
`;
    if (typeof document !== "undefined"
      && document.querySelector('style[data-plugin-css="dsh-attempt-recover"]') === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-attempt-recover";
      tag.dataset.pluginCss = "dsh-attempt-recover";
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * Split one compact Assistant stream into its visible output and its reasoning.
     *
     * Mirrors the Host's joiners: `text-chunks` / `reasoning-chunks` records carry
     * joined fragments, and bare `chunk` records carry single deltas. Tool-call
     * fragments belong to neither section.
     *
     * @param stream - compact records from one durable Assistant settlement.
     * @returns both sections, empty strings when the attempt produced nothing.
     */
    function attemptSections(stream) {
      const text = [];
      const reasoning = [];
      if (Array.isArray(stream)) {
        for (const record of stream) {
          if (record === null || typeof record !== "object") continue;
          if (record.type === "text-chunks" && Array.isArray(record.texts)) {
            text.push(record.texts.join(""));
            continue;
          }
          if (record.type === "reasoning-chunks" && Array.isArray(record.texts)) {
            reasoning.push(record.texts.join(""));
            continue;
          }
          if (record.type !== "chunk") continue;
          const chunk = record.chunk;
          if (chunk === null || typeof chunk !== "object") continue;
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text.push(chunk.text);
          else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") reasoning.push(chunk.text);
        }
      }
      return { text: text.join(""), reasoning: reasoning.join("") };
    }

    /**
     * Ask the Host to append one recovered section to the model-visible surface.
     *
     * @param sessionId - live session id.
     * @param seq - sequence of the `assistant/attempt` event.
     * @param section - `"text"` or `"reasoning"`.
     * @returns the Host result envelope.
     */
    async function recoverThroughHost(sessionId, seq, section) {
      const response = await fetch(ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, seq, section })
      });
      return response.json();
    }

    /** Button state for one section, kept above the disclosure so it survives folding. */
    function useAdmission(sessionId, seq, section) {
      const [status, setStatus] = React.useState("idle");
      const [reason, setReason] = React.useState("");
      const admit = React.useCallback(async () => {
        setStatus("sending");
        setReason("");
        try {
          const result = await recoverThroughHost(sessionId, seq, section);
          if (result.ok) {
            setStatus("done");
            return;
          }
          setStatus("failed");
          setReason(result.error?.message ?? "Host rejected the request");
        } catch (error) {
          setStatus("failed");
          setReason(String(error?.message ?? error));
        }
      }, [sessionId, seq, section]);
      return { status, reason, admit };
    }

    /** One labelled, collapsible stream section with its own re-admission control. */
    function Section({ label, body, sessionId, seq, section }) {
      const [open, setOpen] = React.useState(false);
      const { status, reason, admit } = useAdmission(sessionId, seq, section);
      return h("div", {
        style: {
          borderTop: "1px solid var(--dsw-alias-separator-primary)"
        }
      },
        h("div", {
          style: {
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "6px 12px"
          }
        },
          h("button", {
            type: "button",
            onClick: () => setOpen((value) => !value),
            "aria-expanded": open,
            style: {
              display: "flex",
              alignItems: "center",
              gap: "6px",
              flex: "1 1 auto",
              minWidth: 0,
              padding: 0,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              textAlign: "left",
              color: "var(--dsw-alias-label-tertiary)",
              fontSize: "var(--dsh-content-font-size-secondary)"
            }
          },
            h("span", {
              style: {
                display: "inline-block",
                transition: "transform 120ms ease",
                transform: open ? "rotate(90deg)" : "none"
              }
            }, "▸"),
            h("span", null, `${label} · ${body.chars} 字`)
          ),
          h("button", {
            type: "button",
            onClick: admit,
            disabled: status === "sending" || status === "done",
            style: {
              flex: "0 0 auto",
              padding: "2px 9px",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: "var(--dsw-radius-sm)",
              background: "transparent",
              cursor: status === "idle" || status === "failed" ? "pointer" : "default",
              color: status === "done" ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
              fontSize: "var(--dsh-content-font-size-secondary)",
              opacity: status === "sending" ? 0.6 : 1
            }
          }, status === "sending" ? "正在加回…" : status === "done" ? "已加回" : `加回${label}`)
        ),
        status === "failed"
          ? h("div", {
            style: {
              padding: "0 12px 6px",
              color: "var(--dsw-alias-state-error-primary)",
              fontSize: "var(--dsh-content-font-size-secondary)"
            }
          }, `加回失败：${reason}`)
          : null,
        open
          ? h("div", {
            "data-recovered-body": section,
            style: {
              padding: "0 12px 10px",
              maxHeight: "360px",
              overflow: "auto",
              color: body.tone
            }
          },
            MarkdownText === undefined
              ? h("pre", {
                style: {
                  margin: 0,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily: "inherit",
                  fontSize: "var(--dsh-content-font-size-secondary)",
                  lineHeight: 1.65,
                  color: body.tone
                }
              }, body.text)
              : h(MarkdownText, {
                text: body.text,
                streaming: false,
                labels: MARKDOWN_LABELS
              })
          )
          : null
      );
    }

    /** One failed attempt: a heading, then its reasoning and output sections. */
    function RecoveredAttempt({ attempt, sessionId }) {
      const [open, setOpen] = React.useState(false);
      const total = attempt.text.chars + attempt.reasoning.chars;
      return h("div", {
        style: {
          margin: "8px 0",
          border: "1px solid var(--dsw-alias-border-l2)",
          borderRadius: "var(--dsw-radius-md)",
          background: "var(--dsw-alias-bg-layer-1)",
          overflow: "hidden"
        },
        "data-recovered-attempt": attempt.seq
      },
        h("button", {
          type: "button",
          onClick: () => setOpen((value) => !value),
          "aria-expanded": open,
          style: {
            display: "flex",
            alignItems: "center",
            gap: "6px",
            width: "100%",
            padding: "8px 12px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
            color: "var(--dsw-alias-label-secondary)",
            fontSize: "var(--dsh-content-font-size-secondary)"
          }
        },
          h("span", {
            style: {
              display: "inline-block",
              transition: "transform 120ms ease",
              transform: open ? "rotate(90deg)" : "none",
              color: "var(--dsw-alias-label-tertiary)"
            }
          }, "▸"),
          h("span", {
            style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
          }, `未进入对话的输出 · 第 ${attempt.turn} 轮第 ${attempt.step} 步 · ${total} 字`)
        ),
        open
          ? h("div", null,
            attempt.reasoning.chars > 0
              ? h(Section, {
                label: "思考",
                body: { text: attempt.reasoning.text, chars: attempt.reasoning.chars, tone: "var(--dsw-alias-label-tertiary)" },
                sessionId,
                seq: attempt.seq,
                section: "reasoning"
              })
              : null,
            attempt.text.chars > 0
              ? h(Section, {
                label: "正文",
                body: { text: attempt.text.text, chars: attempt.text.chars, tone: "var(--dsw-alias-label-primary)" },
                sessionId,
                seq: attempt.seq,
                section: "text"
              })
              : null
          )
          : null
      );
    }

    /**
     * Every recovered attempt in one Turn, rendered at the Turn tail.
     *
     * The Turn tail slot sits outside the Turn's process disclosure, so a failed
     * attempt stays visible even when the surrounding activity is folded away.
     */
    function RecoveredAttempts({ turn, useAttempts, sessionId }) {
      const attempts = useAttempts(String(turn.turn));
      if (attempts === undefined || attempts.length === 0) return null;
      return h("div", { "data-recovered-attempts": turn.turn },
        attempts.map((attempt) => h(RecoveredAttempt, { key: attempt.seq, attempt, sessionId }))
      );
    }

    return {
      inject: ["slots", "uiConversation", "sessions"],
      apply(ctx) {
        ctx.effect(() => ctx.uiConversation.events.register({
          kind: KIND,
          target: "chat",
          match: (event) => {
            if (event.type !== "assistant/attempt") return null;
            const sections = attemptSections(event.data?.stream);
            if (sections.text.trim() === "" && sections.reasoning.trim() === "") return null;
            return { id: String(event.seq), role: "start" };
          },
          start: (_context, match) => {
            const event = match.event;
            const sections = attemptSections(event.data.stream);
            return {
              seq: event.seq,
              turn: event.data.turn,
              step: event.data.step,
              text: { text: sections.text, chars: sections.text.length },
              reasoning: { text: sections.reasoning, chars: sections.reasoning.length }
            };
          },
          update: (context) => context.state,
          buildViewNode: (context) => {
            const start = context.start ?? context.matches[0];
            if (start === undefined) return null;
            const data = context.state;
            return {
              key: context.key,
              kind: KIND,
              id: context.id,
              target: "chat",
              anchorSeq: start.event.seq,
              location: start.location,
              // Hidden: the Turn tail renders it, so it never enters the process disclosure.
              visibility: "hidden",
              data
            };
          }
        }), "dsh-attempt-recover: attempt definition");

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: "dsh-attempt-recover",
          locale: NS,
          inject: (sessionId) => {
            const binding = ctx.sessions.binding(sessionId);
            if (binding === void 0) return { keyedHooks: { attempts: () => undefined } };
            const chat = ctx.uiConversation.binding(binding).target("chat");
            return {
              keyedHooks: {
                attempts: (turn) => {
                  const snapshot = chat.getSnapshot();
                  if (snapshot === undefined) return undefined;
                  return snapshot.nodes.turnDataSource(Number(turn), KIND);
                }
              }
            };
          }
        }, RecoveredAttempts));
      }
    };
  }
});
