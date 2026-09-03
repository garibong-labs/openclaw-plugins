import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

type Tool = (params: Record<string, unknown>) => Promise<unknown>;

const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../templates/report-controller-automation.json");
const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
const payload = template.payload as Record<string, unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...values: Tool[]) => Promise<unknown>;

async function evaluate(
  results: Array<Record<string, unknown>>,
): Promise<Array<{ tool: string; params: Record<string, unknown> }>> {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = [];
  const controller: Tool = async (params) => {
    calls.push({ tool: "acp_report_controller", params: structuredClone(params) });
    if (params.action === "release") return { status: "released" };
    return results.shift() ?? { status: "error", code: "acp_lifecycle_guard.controller.failed" };
  };
  const message: Tool = async (params) => {
    calls.push({ tool: "message", params: structuredClone(params) });
    return { ok: true };
  };
  const automations: Tool = async (params) => {
    calls.push({ tool: "automations", params: structuredClone(params) });
    return { removed: true };
  };
  const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
  await run(controller, message, automations);
  return calls;
}

describe("shipped report controller automation", () => {
  it("is a bounded headless script with an exact tool allowlist and no model fields", () => {
    assert.equal(payload.kind, "script");
    assert.equal(payload.timeoutSeconds, 60);
    assert.equal(payload.toolBudget, 5);
    assert.deepEqual(payload.toolsAllow, ["acp_report_controller", "message", "automations"]);
    assert.equal((template.delivery as Record<string, unknown>).mode, "none");
    for (const key of ["message", "model", "fallbacks", "thinking", "lightContext"]) {
      assert.equal(Object.hasOwn(payload, key), false, `script payload must not carry ${key}`);
    }
    assert.doesNotThrow(() => new AsyncFunction("acp_report_controller", "message", "automations",
      String(payload.script)));
  });

  it("sends one returned message byte-for-byte to the returned exact route, then ticks once", async () => {
    const exactMessage = "synthetic report\nwith exact bytes";
    const calls = await evaluate([
      { status: "delivery_pending", message: exactMessage,
        destination: { channel: "discord", accountId: "account-example", conversationId: "1" } },
      { status: "none_due" },
    ]);
    assert.deepEqual(calls, [
      { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
      { tool: "message", params: { action: "send", channel: "discord", target: "1",
        accountId: "account-example", message: exactMessage, final: false } },
      { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
    ]);
  });

  it("never sends a second time when the bounded post-send tick is still pending", async () => {
    const pending = { status: "delivery_pending", message: "synthetic report",
      destination: { channel: "discord", accountId: "account-example", conversationId: "1" } };
    const calls = await evaluate([pending, pending]);
    assert.equal(calls.filter((call) => call.tool === "message").length, 1);
    assert.equal(calls.filter((call) => call.tool === "acp_report_controller" &&
      call.params.action === "tick").length, 2);
    assert.equal(calls.some((call) => call.tool === "automations"), false);
  });

  for (const status of ["none_due", "delivery_missing", "delivery_uncertain", "error"] as const) {
    it(`stays quiet and does not clean up for ${status}`, async () => {
      const result = status === "error" ? { status, code: "acp_lifecycle_guard.controller.failed" } : { status };
      assert.deepEqual(await evaluate([result]), [
        { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
      ]);
    });
  }

  for (const status of ["terminal_acked", "tracking_lost"] as const) {
    it(`removes only the authenticated current job before releasing for ${status}`, async () => {
      assert.deepEqual(await evaluate([{ status, cleanup: "remove_current_job_then_release_lease",
        jobId: "job-example-1" }]), [
        { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
        { tool: "automations", params: { action: "remove", jobId: "job-example-1" } },
        { tool: "acp_report_controller", params: { action: "release", leaseToken: "LEASE_TOKEN" } },
      ]);
    });
  }

  it("releases after a post-send terminal acknowledgement", async () => {
    const calls = await evaluate([
      { status: "delivery_pending", message: "synthetic report",
        destination: { channel: "discord", accountId: "account-example", conversationId: "1" } },
      { status: "terminal_acked", cleanup: "remove_current_job_then_release_lease", jobId: "job-example-1" },
    ]);
    assert.deepEqual(calls.map((call) => call.tool),
      ["acp_report_controller", "message", "acp_report_controller", "automations", "acp_report_controller"]);
  });

  it("does not release when removal of its own job fails", async () => {
    const observed: string[] = [];
    const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
    await assert.rejects(run(
      async (params) => { observed.push(String(params.action)); return { status: "terminal_acked",
        cleanup: "remove_current_job_then_release_lease", jobId: "job-example-1" }; },
      async () => { observed.push("send"); },
      async () => { observed.push("remove"); throw new Error("synthetic removal failure"); },
    ), /synthetic removal failure/u);
    assert.deepEqual(observed, ["tick", "remove"]);
  });
});
