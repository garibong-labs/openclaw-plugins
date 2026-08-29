import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GUARD_CONFIG } from "../src/config.ts";
import type {
  BeforeToolCallHandler,
  GuardHookOptions,
  GuardHostApi,
  MessageSendingHandler,
} from "../src/host-contract.ts";
import { ReasonCodes } from "../src/lifecycle/reason-codes.ts";
import {
  PLUGIN_ID,
  createBeforeToolCallHandler,
  createMessageSendingHandler,
  registerGuard,
} from "../src/register.ts";
import {
  CANONICAL_COMPLETION,
  CANONICAL_INTERMEDIATE,
  ORDINARY_CHAT,
  replaceLine,
} from "./fixtures.ts";

type Registration = {
  hookName: string;
  handler: MessageSendingHandler | BeforeToolCallHandler;
  opts?: GuardHookOptions;
};

type LoggedCall = { level: string; args: unknown[] };

function createFakeApi(pluginConfig?: Record<string, unknown>): {
  api: GuardHostApi;
  registrations: Registration[];
  logs: LoggedCall[];
} {
  const registrations: Registration[] = [];
  const logs: LoggedCall[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push({ level, args });
    };
  const api = {
    id: PLUGIN_ID,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    ...(pluginConfig === undefined ? {} : { pluginConfig }),
    on: ((
      hookName: string,
      handler: MessageSendingHandler | BeforeToolCallHandler,
      opts?: GuardHookOptions,
    ) => {
      registrations.push({ hookName, handler, ...(opts ? { opts } : {}) });
    }) as GuardHostApi["on"],
  } as GuardHostApi;
  return { api, registrations, logs };
}

const MESSAGE_CONTEXT = { channelId: "test-channel" } as const;
const TOOL_CONTEXT = { toolName: "message" } as const;

const MALFORMED_INTERMEDIATE = replaceLine(
  CANONICAL_INTERMEDIATE,
  5,
  "⏱️ **ACP 시간**: 20분",
);

describe("registerGuard", () => {
  it("registers both required hooks exactly once", () => {
    const { api, registrations } = createFakeApi();
    registerGuard(api);
    const names = registrations.map((entry) => entry.hookName).sort();
    assert.deepEqual(names, ["before_tool_call", "message_sending"]);
  });

  it("registers message_sending at a late priority", () => {
    const { api, registrations } = createFakeApi();
    registerGuard(api);
    const outbound = registrations.find(
      (entry) => entry.hookName === "message_sending",
    );
    assert.ok(outbound);
    assert.equal(typeof outbound.handler, "function");
    assert.ok((outbound.opts?.priority ?? 0) < 0);
  });
});

describe("message_sending handler", () => {
  it("returns nothing for ordinary content", () => {
    const { api, logs } = createFakeApi();
    const handler = createMessageSendingHandler(api, DEFAULT_GUARD_CONFIG);
    const result = handler(
      { to: "target", content: ORDINARY_CHAT },
      MESSAGE_CONTEXT,
    );
    assert.equal(result, undefined);
    assert.equal(logs.length, 0);
  });

  it("returns nothing for a canonical report", () => {
    const { api } = createFakeApi();
    const handler = createMessageSendingHandler(api, DEFAULT_GUARD_CONFIG);
    assert.equal(
      handler({ to: "target", content: CANONICAL_COMPLETION }, MESSAGE_CONTEXT),
      undefined,
    );
  });

  it("cancels a malformed report with a stable reason code", () => {
    const { api } = createFakeApi();
    const handler = createMessageSendingHandler(api, DEFAULT_GUARD_CONFIG);
    const result = handler(
      { to: "target", content: MALFORMED_INTERMEDIATE },
      MESSAGE_CONTEXT,
    );
    assert.deepEqual(result, {
      cancel: true,
      cancelReason: ReasonCodes.IntermediateElapsedDrift,
      metadata: {
        pluginId: PLUGIN_ID,
        lifecycleKind: "intermediate",
        reasonCode: ReasonCodes.IntermediateElapsedDrift,
      },
    });
  });

  it("does not cancel while enforcement is disabled", () => {
    const { api, logs } = createFakeApi({ enforce: false });
    const handler = createMessageSendingHandler(api);
    const result = handler(
      { to: "target", content: MALFORMED_INTERMEDIATE },
      MESSAGE_CONTEXT,
    );
    assert.equal(result, undefined);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.level, "info");
  });

  it("tolerates a non-string content field", () => {
    const { api } = createFakeApi();
    const handler = createMessageSendingHandler(api, DEFAULT_GUARD_CONFIG);
    const result = handler(
      { to: "target", content: undefined as unknown as string },
      MESSAGE_CONTEXT,
    );
    assert.equal(result, undefined);
  });
});

describe("before_tool_call handler", () => {
  it("returns nothing for unrelated tools", () => {
    const { api } = createFakeApi();
    const handler = createBeforeToolCallHandler(api, DEFAULT_GUARD_CONFIG);
    assert.equal(
      handler({ toolName: "exec", params: { command: "ls" } }, TOOL_CONTEXT),
      undefined,
    );
  });

  it("blocks a direct intermediate publication", () => {
    const { api } = createFakeApi();
    const handler = createBeforeToolCallHandler(api, DEFAULT_GUARD_CONFIG);
    const result = handler(
      {
        toolName: "message",
        params: { action: "send", message: CANONICAL_INTERMEDIATE },
      },
      TOOL_CONTEXT,
    );
    assert.equal(result?.block, true);
    assert.ok(result?.blockReason?.startsWith(ReasonCodes.ToolDirectIntermediate));
  });

  it("does not block a completion report", () => {
    const { api } = createFakeApi();
    const handler = createBeforeToolCallHandler(api, DEFAULT_GUARD_CONFIG);
    assert.equal(
      handler(
        {
          toolName: "message",
          params: { action: "send", message: CANONICAL_COMPLETION },
        },
        TOOL_CONTEXT,
      ),
      undefined,
    );
  });

  it("tolerates a missing params object", () => {
    const { api } = createFakeApi();
    const handler = createBeforeToolCallHandler(api, DEFAULT_GUARD_CONFIG);
    assert.equal(
      handler(
        { toolName: "message", params: null as unknown as Record<string, unknown> },
        TOOL_CONTEXT,
      ),
      undefined,
    );
  });
});

describe("logging never carries raw outbound content", () => {
  const SECRET_MARKER = "ZZ-UNIQUE-PAYLOAD-MARKER-9137";

  function flatten(logs: LoggedCall[]): string {
    return logs
      .map((entry) =>
        entry.args
          .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
          .join(" "),
      )
      .join("\n");
  }

  it("omits message content when cancelling", () => {
    const { api, logs } = createFakeApi();
    const handler = createMessageSendingHandler(api, DEFAULT_GUARD_CONFIG);
    const tainted = replaceLine(
      MALFORMED_INTERMEDIATE,
      12,
      `- ${SECRET_MARKER}`,
    );
    handler({ to: SECRET_MARKER, content: tainted }, MESSAGE_CONTEXT);

    assert.equal(logs.length, 1);
    const flattened = flatten(logs);
    assert.equal(flattened.includes(SECRET_MARKER), false);
    for (const line of tainted.split("\n")) {
      if (line.trim().length > 0) {
        assert.equal(flattened.includes(line), false);
      }
    }
    assert.match(
      flattened,
      /^\[acp-report-guard\] hook=message_sending outcome=cancelled kind=intermediate reason=acp_report_guard\.[a-z._]+$/u,
    );
  });

  it("omits tool params when blocking", () => {
    const { api, logs } = createFakeApi();
    const handler = createBeforeToolCallHandler(api, DEFAULT_GUARD_CONFIG);
    const tainted = replaceLine(
      CANONICAL_INTERMEDIATE,
      12,
      `- ${SECRET_MARKER}`,
    );
    handler(
      {
        toolName: "message",
        params: { action: "send", message: tainted, to: SECRET_MARKER },
      },
      TOOL_CONTEXT,
    );

    assert.equal(logs.length, 1);
    const flattened = flatten(logs);
    assert.equal(flattened.includes(SECRET_MARKER), false);
    assert.match(
      flattened,
      /^\[acp-report-guard\] hook=before_tool_call outcome=blocked kind=intermediate reason=acp_report_guard\.[a-z._]+$/u,
    );
  });
});
