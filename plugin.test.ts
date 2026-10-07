import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin, {
  findModelViolation,
  violationMessage,
  readViolationsSince,
  recordViolation,
  patchScriptsIn,
  projectLabel,
  stateDir,
  violationsLog,
  SUBAGENT_TOOLS,
  setup,
  guardToolExecution,
  sessionDirectory,
  runSessionStartTasks,
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

// --- V2 (OpenCode 2) wiring -------------------------------------------------
//
// The reason this plugin once failed to load: it only exported the V1
// `{ id, server }` shape. OpenCode 2 accepts `{ id, effect }` or `{ id, setup }`
// and rejects anything else. These tests lock the contract and the hook wiring.

/** Async twin of withHome, because setup() is async. */
async function withHomeAsync(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "agent-guard-"))
  process.env.HOME = home
  try {
    await fn(home)
  } finally {
    process.env.HOME = prev
    rmSync(home, { recursive: true, force: true })
  }
}

/** A fake V2 plugin context that records what setup() registers. */
function fakeV2Context(directory: string) {
  const toolHooks: Record<string, (event: any) => void> = {}
  const subscriptions: Array<{ signal: AbortSignal }> = []
  return {
    toolHooks,
    subscriptions,
    ctx: {
      location: { directory },
      tool: {
        hook: async (name: string, callback: (event: any) => void) => {
          toolHooks[name] = callback
        },
      },
      event: {
        // Empty stream: the background loop ends immediately, no timing needed.
        subscribe: (options: { signal: AbortSignal }) => {
          subscriptions.push(options)
          return (async function* () {})()
        },
      },
    },
  }
}

test("default export satisfies the V2 loader contract (id + setup), keeping V1", () => {
  assert.equal(plugin.id, "opencode-agent-guard")
  assert.equal(typeof plugin.setup, "function", "V2 requires setup or effect")
  assert.equal(typeof plugin.server, "function", "V1 server() is kept for compatibility")
})

test("setup returns a cleanup function for a V2 context and is a no-op for V1", async () => {
  assert.equal(await setup({}), undefined, "a V1-shaped context must not be touched")
  assert.equal(
    await setup({ project: {}, directory: "/x", client: {} }),
    undefined,
    "a V1 PluginInput has no tool/event domains",
  )

  const { ctx, subscriptions } = fakeV2Context("/a/b/ocr-cat")
  const cleanup = await setup(ctx)
  assert.equal(typeof cleanup, "function")
  assert.equal(subscriptions.length, 1, "one session-event subscription")
  assert.equal(subscriptions[0].signal.aborted, false)
  cleanup?.()
  assert.equal(subscriptions[0].signal.aborted, true, "cleanup must abort the stream")
})

test("V2 tool hook refuses a subagent carrying a model and records the violation", async () => {
  await withHomeAsync(async () => {
    const { ctx, toolHooks } = fakeV2Context("/a/b/ocr-cat")
    await setup(ctx)
    const before = toolHooks["execute.before"]
    assert.equal(typeof before, "function")

    assert.throws(
      () => before({ tool: "subagent", input: { agent: "general", model: "expensive/big" }, sessionID: "ses_x" }),
      /Blocked: subagent dispatch carried an explicit model \(expensive\/big\)/,
    )

    const rows = readViolationsSince(new Date(Date.now() - 60_000).toISOString())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].model, "expensive/big")
    assert.equal(rows[0].tool, "subagent")
    assert.equal(rows[0].project, "ocr-cat", "project comes from ctx.location.directory")
  })
})

test("V2 tool hook allows a clean dispatch", async () => {
  await withHomeAsync(async () => {
    const { ctx, toolHooks } = fakeV2Context("/a/b/ocr-cat")
    await setup(ctx)
    assert.doesNotThrow(() => toolHooks["execute.before"]({ tool: "subagent", input: { agent: "general" } }))
    assert.deepEqual(readViolationsSince(new Date(Date.now() - 60_000).toISOString()), [])
  })
})

test("guardToolExecution tolerates malformed V2 events rather than throwing", () => {
  withHome(() => {
    assert.doesNotThrow(() => guardToolExecution(undefined, "p"))
    assert.doesNotThrow(() => guardToolExecution({ tool: "read", input: { model: "p/m" } }))
    assert.doesNotThrow(() => guardToolExecution({ tool: "subagent", input: null }))
  })
})

test("sessionDirectory reads a V2 session.created event, ignoring other events", () => {
  assert.equal(
    sessionDirectory({ type: "session.created", properties: { info: { directory: "/x/y" } } }),
    "/x/y",
  )
  assert.equal(sessionDirectory({ type: "session.idle", properties: { sessionID: "s" } }), undefined)
  assert.equal(
    sessionDirectory({ type: "session.created", properties: { info: {} } }, "/fallback"),
    "/fallback",
  )
  assert.equal(sessionDirectory({ type: "session.created", properties: { info: {} } }), undefined)
  assert.equal(sessionDirectory(undefined, ""), undefined)
})

test("runSessionStartTasks reports prior violations and runs project patch scripts", () => {
  withHome((home) => {
    recordViolation({ model: "p/m", tool: "subagent", project: "ocr-cat" })
    const patchDir = join(home, "scripts", "patches")
    mkdirSync(patchDir, { recursive: true })
    writeFileSync(join(patchDir, "fix.sh"), "#!/usr/bin/env bash\necho 'status: patched'\n", { mode: 0o755 })

    const warns: string[] = []
    const logs: string[] = []
    const origWarn = console.warn
    const origLog = console.log
    console.warn = (...args: unknown[]) => warns.push(args.join(" "))
    console.log = (...args: unknown[]) => logs.push(args.join(" "))
    try {
      runSessionStartTasks(home)
    } finally {
      console.warn = origWarn
      console.log = origLog
    }

    assert.ok(warns.some((w) => w.includes("1 subagent model override")))
    assert.ok(logs.some((l) => l.includes("fix.sh: status: patched")))
  })
})