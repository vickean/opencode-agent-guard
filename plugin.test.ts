import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  findModelViolation,
  violationMessage,
  readViolationsSince,
  recordViolation,
  patchScriptsIn,
  projectLabel,
  stateDir,
  violationsLog,
  SUBAGENT_TOOLS,
} from "./plugin.ts"

/** Point HOME at a temp dir for the duration of fn, so state writes are isolated. */
function withHome<T>(fn: (home: string) => T): T {
  const prev = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "agent-guard-"))
  process.env.HOME = home
  try {
    return fn(home)
  } finally {
    process.env.HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

test("findModelViolation flags a subagent carrying a model", () => {
  assert.equal(
    findModelViolation("subagent", { agent: "general", model: "expensive/big" }),
    "expensive/big",
  )
})

test("findModelViolation matches the Task tool name case-insensitively", () => {
  assert.equal(findModelViolation("Task", { model: "p/m" }), "p/m")
  assert.equal(findModelViolation("task", { model: "p/m" }), "p/m")
})

test("findModelViolation ignores an absent, null, or blank model", () => {
  assert.equal(findModelViolation("subagent", { agent: "general" }), null)
  assert.equal(findModelViolation("subagent", { model: null }), null)
  assert.equal(findModelViolation("subagent", { model: "" }), null)
  assert.equal(findModelViolation("subagent", { model: "   " }), null)
})

test("findModelViolation ignores tools that do not dispatch a subagent", () => {
  assert.equal(findModelViolation("Bash", { command: "ls" }), null)
  assert.equal(findModelViolation("read", { model: "p/m" }), null)
  assert.equal(findModelViolation("bash", { model: "p/m" }), null)
})

test("findModelViolation tolerates malformed input rather than throwing", () => {
  assert.equal(findModelViolation(undefined, undefined), null)
  assert.equal(findModelViolation(null, null), null)
  assert.equal(findModelViolation(42, { model: "p/m" }), null)
  assert.equal(findModelViolation("subagent", "not-an-object"), null)
})

test("violationMessage names the model and tells the agent what to do instead", () => {
  const msg = violationMessage("expensive/big")
  assert.ok(msg.includes("expensive/big"))
  assert.ok(msg.includes("opencode.json"))
  assert.ok(msg.includes("Do not pass `model`"))
  assert.ok(msg.includes("check-agent-models.mjs"))
})

test("SUBAGENT_TOOLS covers the names we actually dispatch with", () => {
  assert.ok(SUBAGENT_TOOLS.includes("subagent" as never))
})

test("readViolationsSince returns [] when no log exists", () => {
  withHome(() => {
    assert.deepEqual(readViolationsSince(new Date(Date.now() - 1000).toISOString()), [])
  })
})

test("recordViolation actually writes a readable line", () => {
  // The fail-visible mechanism. If this silently no-ops, the guard can report
  // that it is not enforcing only by never saying anything — which is the
  // exact failure mode this plugin exists to prevent.
  withHome((home) => {
    recordViolation({ model: "expensive/big", tool: "subagent", project: "ocr-cat" })
    assert.ok(existsSync(violationsLog()), "violations.log must exist after a record")
    const rows = readViolationsSince(new Date(Date.now() - 60_000).toISOString())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].model, "expensive/big")
    assert.equal(rows[0].tool, "subagent")
    assert.ok(rows[0].at)
    assert.ok(violationsLog().startsWith(home), "log must live under the current HOME")
  })
})

test("violations carry project attribution, because the log is per-machine not per-repo", () => {
  // On a shared machine one repo's violation must be distinguishable from
  // another's, or the session-start warning reports an unattributable count.
  withHome(() => {
    recordViolation({ model: "p/m", tool: "subagent", project: "ocr-cat" })
    recordViolation({ model: "q/n", tool: "subagent", project: "foresight-accounting" })
    const rows = readViolationsSince(new Date(Date.now() - 60_000).toISOString())
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.project).sort(), ["foresight-accounting", "ocr-cat"])
  })
})

test("projectLabel derives a short repo label and tolerates a missing dir", () => {
  assert.equal(projectLabel({ directory: "/a/b/ocr-cat" }), "ocr-cat")
  assert.equal(projectLabel({ cwd: "/x/y/foresight-accounting" }), "foresight-accounting")
  assert.ok(typeof projectLabel({}) === "string")
  assert.ok(projectLabel({}).length > 0)
})

test("readViolationsSince filters by timestamp and skips torn lines", () => {
  withHome(() => {
    const old = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString()
    const fresh = new Date().toISOString()
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(
      violationsLog(),
      [
        JSON.stringify({ at: old, model: "old/model", tool: "subagent" }),
        "{not json", // torn line
        JSON.stringify({ at: fresh, model: "new/model", tool: "subagent" }),
        "", // trailing blank
      ].join("\n") + "\n",
    )
    const rows = readViolationsSince(new Date(Date.now() - 3600_000).toISOString())
    assert.equal(rows.length, 1, "only the fresh record, and the torn line skipped")
    assert.equal(rows[0].model, "new/model")
  })
})

test("patchScriptsIn finds only executable .sh files under scripts/patches", () => {
  withHome((home) => {
    const dir = join(home, "scripts", "patches")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "run.sh"), "#!/usr/bin/env bash\n", { mode: 0o755 })
    writeFileSync(join(dir, "not-exec.sh"), "#!/usr/bin/env bash\n", { mode: 0o644 })
    writeFileSync(join(dir, "notes.md"), "x")
    const found = patchScriptsIn(home)
    assert.equal(found.length, 1)
    assert.ok(found[0].endsWith("run.sh"))
  })
})

test("patchScriptsIn returns [] for a project with no scripts/patches", () => {
  withHome((home) => {
    assert.deepEqual(patchScriptsIn(home), [])
  })
})

test("stateDir and violationsLog are derived from the live HOME", () => {
  withHome((home) => {
    assert.equal(stateDir(), `${home}/.local/state/opencode-agent-guard`)
    assert.equal(violationsLog(), `${home}/.local/state/opencode-agent-guard/violations.log`)
  })
})