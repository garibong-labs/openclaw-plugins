import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_GUARD_CONFIG } from "../src/config.ts";
import { ReasonCodes, isReasonCode } from "../src/lifecycle/reason-codes.ts";
import {
  ACP_LAUNCH_ENTRYPOINT_BASENAMES,
  ACP_SPAWN_RUNTIME,
  AUTHORIZED_LAUNCH_AGENT_ID,
  commandInvokesAcpEntrypoint,
  evaluateAcpLaunch,
  isRecognizedAcpLaunch,
} from "../src/policy/launch.ts";
import { ACP_LAUNCH_COMMAND, ORDINARY_COMMAND } from "./fixtures.ts";

const MAIN = { agentId: AUTHORIZED_LAUNCH_AGENT_ID };
const OTHER = { agentId: "example-helper-agent" };

function execEvent(command: unknown): {
  toolName: string;
  params: Record<string, unknown>;
} {
  return { toolName: "exec", params: { command } };
}

function spawnEvent(runtime: unknown): {
  toolName: string;
  params: Record<string, unknown>;
} {
  return { toolName: "sessions_spawn", params: { runtime, task: "example" } };
}

describe("commandInvokesAcpEntrypoint", () => {
  it("recognizes every canonical entrypoint basename", () => {
    for (const basename of ACP_LAUNCH_ENTRYPOINT_BASENAMES) {
      assert.equal(
        commandInvokesAcpEntrypoint(`node ./example-tools/${basename}`),
        true,
      );
    }
  });

  it("recognizes quoted, chained, and uppercase-path invocations", () => {
    assert.equal(
      commandInvokesAcpEntrypoint(
        'cd example-dir && node "./example tools/claude-acp-launcher.mjs" --flag',
      ),
      true,
    );
    assert.equal(
      commandInvokesAcpEntrypoint(
        "true;node example\\tools\\ACPX-FOREGROUND-SUPERVISOR.MJS",
      ),
      true,
    );
  });

  it("recognizes direct execution and command position after separators", () => {
    assert.equal(
      commandInvokesAcpEntrypoint("./example-tools/claude-acp-launcher.mjs"),
      true,
    );
    assert.equal(
      commandInvokesAcpEntrypoint("true && node ./acp-host-transport-cli.mjs"),
      true,
    );
    assert.equal(
      commandInvokesAcpEntrypoint("false || ./acpx-foreground-supervisor.mjs"),
      true,
    );
    assert.equal(
      commandInvokesAcpEntrypoint("echo start | node claude-acp-launcher.mjs"),
      true,
    );
    assert.equal(
      commandInvokesAcpEntrypoint(
        "EXAMPLE_FLAG=1 node --enable-source-maps ./claude-acp-launcher.mjs",
      ),
      true,
    );
  });

  it("ignores ordinary commands, even ACP-adjacent ones", () => {
    assert.equal(commandInvokesAcpEntrypoint(ORDINARY_COMMAND), false);
    assert.equal(commandInvokesAcpEntrypoint("echo acp launch soon"), false);
    assert.equal(
      commandInvokesAcpEntrypoint("cat notes/acp-host-transport-cli.md"),
      false,
    );
  });

  it("ignores launcher basenames outside command position", () => {
    assert.equal(
      commandInvokesAcpEntrypoint("cat ./tools/acp-host-transport-cli.mjs"),
      false,
    );
    assert.equal(
      commandInvokesAcpEntrypoint("rg acp-host-transport-cli.mjs docs"),
      false,
    );
    assert.equal(
      commandInvokesAcpEntrypoint("echo ./claude-acp-launcher.mjs"),
      false,
    );
    assert.equal(
      commandInvokesAcpEntrypoint(
        "ls; grep -n launch ./acpx-foreground-supervisor.mjs",
      ),
      false,
    );
    assert.equal(
      commandInvokesAcpEntrypoint("node lint.mjs claude-acp-launcher.mjs"),
      false,
    );
  });

  it("treats uninspectable commands as not a launch", () => {
    assert.equal(commandInvokesAcpEntrypoint(undefined), false);
    assert.equal(commandInvokesAcpEntrypoint(null), false);
    assert.equal(commandInvokesAcpEntrypoint(42), false);
    assert.equal(commandInvokesAcpEntrypoint(["node", "x.mjs"]), false);
    assert.equal(commandInvokesAcpEntrypoint({ run: ACP_LAUNCH_COMMAND }), false);
  });
});

describe("isRecognizedAcpLaunch", () => {
  it("recognizes a shell launch and an acp session spawn", () => {
    assert.equal(isRecognizedAcpLaunch(execEvent(ACP_LAUNCH_COMMAND)), true);
    assert.equal(isRecognizedAcpLaunch(spawnEvent(ACP_SPAWN_RUNTIME)), true);
  });

  it("ignores unrelated session spawns", () => {
    assert.equal(isRecognizedAcpLaunch(spawnEvent("subagent")), false);
    assert.equal(isRecognizedAcpLaunch(spawnEvent(undefined)), false);
    assert.equal(isRecognizedAcpLaunch(spawnEvent("ACP")), false);
    assert.equal(isRecognizedAcpLaunch(spawnEvent(7)), false);
  });

  it("ignores other tools even with launch-like params", () => {
    assert.equal(
      isRecognizedAcpLaunch({
        toolName: "read",
        params: { command: ACP_LAUNCH_COMMAND, runtime: ACP_SPAWN_RUNTIME },
      }),
      false,
    );
  });
});

describe("evaluateAcpLaunch", () => {
  it("passes an authorized main-agent launch", () => {
    assert.deepEqual(
      evaluateAcpLaunch(execEvent(ACP_LAUNCH_COMMAND), MAIN, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
    assert.deepEqual(
      evaluateAcpLaunch(spawnEvent(ACP_SPAWN_RUNTIME), MAIN, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
  });

  it("blocks a launch from another agent", () => {
    assert.deepEqual(
      evaluateAcpLaunch(
        execEvent(ACP_LAUNCH_COMMAND),
        OTHER,
        DEFAULT_GUARD_CONFIG,
      ),
      { action: "block", reasonCode: ReasonCodes.LaunchNonMainAgent },
    );
    assert.deepEqual(
      evaluateAcpLaunch(
        spawnEvent(ACP_SPAWN_RUNTIME),
        OTHER,
        DEFAULT_GUARD_CONFIG,
      ),
      { action: "block", reasonCode: ReasonCodes.LaunchNonMainAgent },
    );
  });

  it("treats missing, empty, and differently cased agent ids as unauthorized", () => {
    for (const agentId of [undefined, "", "Main", "MAIN", " main", "main "]) {
      const decision = evaluateAcpLaunch(
        execEvent(ACP_LAUNCH_COMMAND),
        { agentId },
        DEFAULT_GUARD_CONFIG,
      );
      assert.equal(decision.action, "block", `agentId=${JSON.stringify(agentId)}`);
    }
  });

  it("passes malformed launch-like params it cannot inspect", () => {
    assert.deepEqual(
      evaluateAcpLaunch(execEvent(42), OTHER, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
    assert.deepEqual(
      evaluateAcpLaunch(
        { toolName: "exec", params: {} },
        OTHER,
        DEFAULT_GUARD_CONFIG,
      ),
      { action: "pass" },
    );
  });

  it("passes ordinary commands and unrelated spawns from any agent", () => {
    assert.deepEqual(
      evaluateAcpLaunch(execEvent(ORDINARY_COMMAND), OTHER, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
    assert.deepEqual(
      evaluateAcpLaunch(
        execEvent("cat ./tools/acp-host-transport-cli.mjs"),
        OTHER,
        DEFAULT_GUARD_CONFIG,
      ),
      { action: "pass" },
    );
    assert.deepEqual(
      evaluateAcpLaunch(spawnEvent("subagent"), OTHER, DEFAULT_GUARD_CONFIG),
      { action: "pass" },
    );
  });

  it("observes instead of blocking when enforcement is off", () => {
    assert.deepEqual(
      evaluateAcpLaunch(execEvent(ACP_LAUNCH_COMMAND), OTHER, {
        ...DEFAULT_GUARD_CONFIG,
        enforce: false,
      }),
      { action: "observe", reasonCode: ReasonCodes.LaunchNonMainAgent },
    );
  });

  it("observes when the launch guard toggle is off", () => {
    assert.deepEqual(
      evaluateAcpLaunch(execEvent(ACP_LAUNCH_COMMAND), OTHER, {
        ...DEFAULT_GUARD_CONFIG,
        blockNonMainAcpLaunches: false,
      }),
      { action: "observe", reasonCode: ReasonCodes.LaunchNonMainAgent },
    );
  });

  it("uses a stable enumerated reason code", () => {
    assert.equal(isReasonCode(ReasonCodes.LaunchNonMainAgent), true);
    assert.equal(
      ReasonCodes.LaunchNonMainAgent,
      "acp_lifecycle_guard.launch.non_main_agent",
    );
  });
});
