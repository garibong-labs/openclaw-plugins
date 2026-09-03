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

  it("passes one opaque publication token to the message tool, then ticks once", async () => {
    const publicationToken = "acp-pub-example-token-00000001";
    const calls = await evaluate([
      { status: "delivery_pending", publicationToken },
      { status: "none_due" },
    ]);
    assert.deepEqual(calls, [
      { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
      { tool: "message", params: { action: "send", message: publicationToken, final: false } },
      { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
    ]);
  });

  it("never sends a second time when the bounded post-send tick is still pending", async () => {
    const pending = { status: "delivery_pending", publicationToken: "acp-pub-example-token-00000001" };
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
      assert.deepEqual(await evaluate([{ status, cleanup: "remove_current_job_then_release_lease" }]), [
        { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
        { tool: "automations", params: { action: "remove", jobId: "JOB_ID" } },
        { tool: "acp_report_controller", params: { action: "release", leaseToken: "LEASE_TOKEN" } },
      ]);
    });
  }

  it("releases after a post-send terminal acknowledgement", async () => {
    const calls = await evaluate([
      { status: "delivery_pending", publicationToken: "acp-pub-example-token-00000001" },
      { status: "terminal_acked", cleanup: "remove_current_job_then_release_lease" },
    ]);
    assert.deepEqual(calls.map((call) => call.tool),
      ["acp_report_controller", "message", "acp_report_controller", "automations", "acp_report_controller"]);
  });

  it("does not release when removal of its own job fails", async () => {
    const observed: string[] = [];
    const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
    await assert.rejects(run(
      async (params) => { observed.push(String(params.action)); return { status: "terminal_acked",
        cleanup: "remove_current_job_then_release_lease" }; },
      async () => { observed.push("send"); },
      async () => { observed.push("remove"); throw new Error("synthetic removal failure"); },
    ), /synthetic removal failure/u);
    assert.deepEqual(observed, ["tick", "remove"]);
  });

  it("removes the exact current job before transport-proven prepared recovery", async () => {
    const calls = await evaluate([
      { status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" },
      { status: "aborted" },
    ]);
    assert.deepEqual(calls, [
      { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
      { tool: "automations", params: { action: "remove", jobId: "JOB_ID" } },
      { tool: "acp_report_controller", params: { action: "abort_preactivation", leaseToken: "LEASE_TOKEN" } },
    ]);
  });

  it("retains the prepared lease and never aborts when exact job removal fails", async () => {
    const observed: string[] = [];
    let leasePresent = true;
    const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
    await assert.rejects(run(
      async (params) => {
        observed.push(String(params.action));
        if (params.action === "abort_preactivation") leasePresent = false;
        return { status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" };
      },
      async () => { observed.push("send"); },
      async () => { observed.push("remove"); throw new Error("synthetic removal failure"); },
    ), /synthetic removal failure/u);
    assert.deepEqual(observed, ["tick", "remove"]);
    assert.equal(leasePresent, true);
  });

  it("leaves the job removed and prepared lease retained when attested abort fails", async () => {
    const observed: string[] = [];
    let jobPresent = true;
    let leasePresent = true;
    const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
    await run(
      async (params) => {
        observed.push(String(params.action));
        if (params.action === "tick") {
          return { status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" };
        }
        const result: Record<string, string> = {
          status: "error", code: "acp_lifecycle_guard.controller.preactivation_abort_denied",
        };
        if (result.status === "aborted") leasePresent = false;
        return result;
      },
      async () => { observed.push("send"); },
      async () => { observed.push("remove"); jobPresent = false; return { removed: true }; },
    );
    assert.deepEqual(observed, ["tick", "remove", "abort_preactivation"]);
    assert.equal(jobPresent, false);
    assert.equal(leasePresent, true);
  });
});
