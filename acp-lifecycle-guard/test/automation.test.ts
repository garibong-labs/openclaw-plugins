import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

type Tool = (params: Record<string, unknown>) => Promise<unknown>;

const templatePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../templates/report-controller-automation.json");
const readmePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../README.md");
const template = JSON.parse(fs.readFileSync(templatePath, "utf8")) as Record<string, unknown>;
const payload = template.payload as Record<string, unknown>;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...values: Tool[]) => Promise<unknown>;

async function evaluate(
  results: Array<Record<string, unknown>>,
  removalResult: unknown = { removed: true },
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
    return removalResult;
  };
  const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
  const result = await run(controller, message, automations);
  assert.deepEqual(result, {}, "every non-throwing script path must return a bounded object");
  assert.equal(Object.getPrototypeOf(result), Object.prototype,
    "the headless result must be a plain object");
  assert.equal(JSON.stringify(result), "{}", "the headless result must not expose private data");
  return calls;
}

describe("shipped report controller automation", () => {
  it("polls every minute without changing the ten-minute report cadence", () => {
    const schedule = template.schedule as Record<string, unknown>;
    assert.deepEqual(schedule, { kind: "every", everyMs: 60_000 });
    const readme = fs.readFileSync(readmePath, "utf8");
    assert.match(readme, /every-60000-ms isolated polling job/u);
    assert.match(readme, /Report\s+eligibility remains transport-owned at each 600000-ms cadence/u);
  });

  it("documents prepared scheduler ticks as inert and owner recovery as coordinator-owned", () => {
    const readme = fs.readFileSync(readmePath, "utf8");
    const persistedStart = readme.indexOf("**Persisted prepared lease");
    const rejectionStart = readme.indexOf("**Proven pre-persistence rejection");
    const unresolvedStart = readme.indexOf("A thrown, lost, malformed");
    assert.notEqual(persistedStart, -1);
    assert.notEqual(rejectionStart, -1);
    assert.notEqual(unresolvedStart, -1);
    assert.ok(persistedStart < rejectionStart && rejectionStart < unresolvedStart);
    const persistedBranch = readme.slice(persistedStart, rejectionStart);
    const rejectionBranch = readme.slice(rejectionStart, unresolvedStart);

    assert.match(readme,
      /exact successful order is automation add\/arm,\s+transport prepare, controller `register` \(`prepared`\), transport `activate`,\s+then controller `commit_activation` \(`active`\)/u);
    assert.match(persistedBranch, /lost registration response recovered\s+as `prepared`/u);
    assert.match(persistedBranch, /exact-job removal is proven[\s\S]*?controller\s+`abort_preactivation\(\{ leaseToken \}\)`/u);
    assert.match(persistedBranch,
      /Only the controller's exact attested\s+preactivation-aborted proof releases that lease/u);
    assert.match(rejectionBranch, /no controller lease exists/u);
    assert.match(rejectionBranch,
      /coordinator first proves exact-job removal, then directly calls the attested\s+`abortHostTransportPreactivation\(\{ transportFile, processHandle \}\)`/u);
    assert.match(rejectionBranch, /no controller\s+lease to abort, retain, or release/u);
    assert.doesNotMatch(rejectionBranch,
      /controller\s+`abort_preactivation|private lease token|prepared lease (?:is )?retained/u);
    assert.match(readme,
      /unresolved registration response is\s+not a proven pre-persistence rejection[\s\S]*?byte-identical registration replay/u);
    assert.match(readme,
      /Prepared and other error results\s+remain silent and inert:[\s\S]*?return the scheduler-safe plain object `\{\}`/u);
    assert.match(readme,
      /persisted prepared-lease cleanup remains in the owner-driven preparation\s+coordinator, while a proven pre-persistence rejection leaves no controller\s+lease and the coordinator directly aborts the attested transport/u);
    assert.doesNotMatch(readme,
      /[Aa] prepared result uses that same\s+verifier before requesting attested preactivation abort/u);
    assert.doesNotMatch(readme,
      /shipped job template performs this ordering when it encounters\s+`lease_prepared`/u);
  });

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

  const cleanupPaths = [{
    name: "terminal release",
    result: { status: "terminal_acked", cleanup: "remove_current_job_then_release_lease" },
    forbiddenAction: "release",
  }] as const;

  const canonicalRemovalEvidence: Array<{ name: string; value: unknown }> = [
    { name: "unwrapped removed", value: { removed: true } },
    { name: "unwrapped status", value: { status: "removed" } },
    { name: "wrapped removed", value: { details: { removed: true } } },
    { name: "wrapped status", value: { details: { status: "removed" } } },
    { name: "consistent multi-signal", value: {
      removed: true, status: "removed", success: true,
      details: { removed: true, status: "removed", success: true },
    } },
  ];

  for (const pathCase of cleanupPaths) {
    for (const evidence of canonicalRemovalEvidence) {
      it(`${pathCase.name} accepts canonical ${evidence.name} evidence`, async () => {
        const calls = await evaluate([pathCase.result], evidence.value);
        assert.equal(calls.some((call) => call.tool === "acp_report_controller" &&
          call.params.action === pathCase.forbiddenAction), true);
      });
    }
  }

  const unprovenRemovalEvidence: Array<{ name: string; value: unknown }> = [
    { name: "null response", value: null },
    { name: "array response", value: [] },
    { name: "scalar response", value: true },
    { name: "absent evidence", value: {} },
    { name: "false removed", value: { removed: false } },
    { name: "non-boolean removed", value: { removed: "true" } },
    { name: "noncanonical status", value: { status: "deleted" } },
    { name: "non-string status", value: { status: true } },
    { name: "error evidence", value: { removed: true, error: "synthetic_error" } },
    { name: "failure evidence", value: { removed: true, failure: true } },
    { name: "false success", value: { removed: true, success: false } },
    { name: "non-boolean success", value: { removed: true, success: "true" } },
    { name: "null details", value: { removed: true, details: null } },
    { name: "array details", value: { removed: true, details: [] } },
    { name: "non-plain details", value: { removed: true, details: new Date(0) } },
    { name: "top positive and wrapped false removed", value: {
      removed: true, details: { removed: false },
    } },
    { name: "wrapped positive and top false removed", value: {
      removed: false, details: { removed: true },
    } },
    { name: "top positive and wrapped noncanonical status", value: {
      removed: true, details: { status: "deleted" },
    } },
    { name: "wrapped positive and top noncanonical status", value: {
      status: "deleted", details: { removed: true },
    } },
    { name: "top positive and wrapped failure", value: {
      removed: true, details: { failure: true },
    } },
    { name: "wrapped positive and top error", value: {
      error: true, details: { status: "removed" },
    } },
    { name: "cross-level false success", value: {
      status: "removed", details: { success: false },
    } },
  ];

  for (const pathCase of cleanupPaths) {
    for (const evidence of unprovenRemovalEvidence) {
      it(`${pathCase.name} rejects ${evidence.name}`, async () => {
        const calls = await evaluate([pathCase.result], evidence.value);
        assert.deepEqual(calls.slice(0, 2), [
          { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
          { tool: "automations", params: { action: "remove", jobId: "JOB_ID" } },
        ]);
        assert.equal(calls.some((call) => call.tool === "acp_report_controller" &&
          call.params.action === pathCase.forbiddenAction), false,
        `${pathCase.forbiddenAction} must not be touched without proven removal`);
        assert.equal(calls.length, 2);
      });
    }
  }

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

  it("leaves a prepared lease and its exact job recoverable after one scheduler tick", async () => {
    const calls = await evaluate([
      { status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" },
    ]);
    assert.deepEqual(calls, [
      { tool: "acp_report_controller", params: { action: "tick", leaseToken: "LEASE_TOKEN" } },
    ]);
  });

  it("leaves a prepared lease and its exact job recoverable across repeated scheduler ticks", async () => {
    const observed: string[] = [];
    let jobPresent = true;
    let leasePresent = true;
    const run = new AsyncFunction("acp_report_controller", "message", "automations", String(payload.script));
    for (let tick = 0; tick < 3; tick += 1) {
      const result = await run(
        async (params) => {
          observed.push(String(params.action));
          if (params.action === "abort_preactivation") leasePresent = false;
          return { status: "error", code: "acp_lifecycle_guard.controller.lease_prepared" };
        },
        async () => { observed.push("send"); },
        async () => { observed.push("remove"); jobPresent = false; return { removed: true }; },
      );
      assert.deepEqual(result, {});
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
    }
    assert.deepEqual(observed, ["tick", "tick", "tick"]);
    assert.equal(jobPresent, true);
    assert.equal(leasePresent, true);
  });
});
