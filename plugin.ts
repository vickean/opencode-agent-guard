/**
 * opencode-agent-guard
 *
 * Two guards for agent-driven coding sessions:
 *
 * 1. SUBAGENT MODEL GUARD (V2 `ctx.tool.hook("execute.before")`, V1
 *    `tool.execute.before`)
 *    Blocks a subagent dispatch that carries an explicit `model` argument.
 *    Each agent's model is chosen by `agent.<name>.model` in opencode.json.
 *    An explicit `model:` silently overrides that pin, and nothing reports the
 *    override — the operator's configured model simply stops being used, with
 *    no error and no signal. That failure is invisible from inside the
 *    conversation: the agent has no way to notice it is not running the model
 *    the operator believes it is.
 *
 * 2. SKILL PATCH RE-APPLY (V2 `session.created` event, V1 `session.created`
 *    hook)
 *    Plugin install paths encode the upstream commit
 *    (`~/.cache/opencode/npm/git-<plugin>-<commit>/…`), so every plugin update
 *    lands a fresh directory and discards any local edit. A repo can ship a
 *    repaired patch script under `scripts/patches/`; this runs those on every
 *    session start, which is exactly when an update has landed.
 *
 * THE SAFETY NET
 *   Guard 1 refuses the dispatch by throwing from the tool hook. It does not
 *   rely on the throw alone: a violation is recorded to a log file *before*
 *   throwing, and the `session.created` handler reads that log back and reports
 *   unresolved violations. If the throw is ever swallowed, the operator finds
 *   out at the next session start instead of never. Silent failure is the thing
 *   this plugin exists to prevent, so it refuses to have one of its own.
 */

import { mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"

/** Tool names that dispatch a subagent. Matched case-insensitively. */
export const SUBAGENT_TOOLS = ["subagent", "task"] as const

/**
 * Where violations and session reports are recorded. Resolved lazily so a test
 * can point HOME at a temp dir — and so a module-load-time capture cannot go
 * stale if HOME changes.
 */
export function stateDir(): string {
  return `${process.env.HOME}/.local/state/opencode-agent-guard`
}

export function violationsLog(): string {
  return `${stateDir()}/violations.log`
}

/**
 * The model a dispatch is trying to force, or null when the dispatch is clean.
 *
 * A `model` that is absent, null, or undefined is NOT a violation — only a
 * value the plugin would actually act on.
 */
export function findModelViolation(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== "string") return null
  if (!SUBAGENT_TOOLS.includes(toolName.toLowerCase() as (typeof SUBAGENT_TOOLS)[number])) return null
  if (toolInput === null || typeof toolInput !== "object") return null
  const model = (toolInput as Record<string, unknown>).model
  if (model === undefined || model === null) return null
  if (typeof model === "string" && model.trim() === "") return null
  return String(model)
}

/** The message shown to the agent when its dispatch is refused. */
export function violationMessage(model: string): string {
  return [
    `Blocked: subagent dispatch carried an explicit model (${model}).`,
    "",
    "Do not pass `model` when dispatching a subagent. Each agent's model is set by",
    "`agent.<name>.model` in opencode.json; an explicit model silently overrides that",
    "pin and nothing reports the override, so the operator's configured model stops",
    "being used with no error and no signal.",
    "",
    "Re-dispatch with only `agent:` (plus `description` / `prompt` / `sessionID`).",
    "If you believe the configured model is wrong, say so and let the operator change",
    "it — do not override per-dispatch. To see what is configured, run:",
    "  node scripts/check-agent-models.mjs",
  ].join("\n")
}

/** Best-effort project attribution, so a shared log is not ambiguous. */
export function projectLabel(input: any): string {
  const dir = input?.directory ?? input?.cwd ?? input?.projectDir ?? process.cwd()
  return dir.split("/").filter(Boolean).pop() ?? dir
}

/**
 * Append one JSONL record. Never throws — logging must not break a session —
 * but a failure is surfaced on stderr rather than swallowed, because a guard
 * whose own logging is silently broken cannot report that it is not enforcing.
 *
 * `project` and `session` are included because the log is per-machine, not
 * per-project: without them a violation from one repo is indistinguishable from
 * a violation in another, which is worse than no log.
 */
export function recordViolation(entry: { model: string; tool: string; project?: string; session?: string }): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    appendFileSync(violationsLog(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch (err) {
    console.warn(`[agent-guard] could not record violation: ${(err as Error).message}`)
  }
}

/** Read violations newer than `sinceIso`, oldest first. Unparseable lines are skipped. */
export function readViolationsSince(sinceIso: string): Array<{ at: string; model: string; tool: string }> {
  let raw: string
  try {
    raw = readFileSync(violationsLog(), "utf8")
  } catch {
    return []
  }
  const out: Array<{ at: string; model: string; tool: string }> = []
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec && typeof rec.at === "string" && rec.at > sinceIso) out.push(rec)
    } catch {
      /* skip a torn line rather than failing the session */
    }
  }
  return out
}

/** Executable patch scripts a project exposes under scripts/patches/. */
export function patchScriptsIn(dir: string): string[] {
  const p = `${dir}/scripts/patches`
  let names: string[]
  try {
    names = readdirSync(p)
  } catch {
    return []
  }
  return names
    .filter((f) => f.endsWith(".sh"))
    .map((f) => `${p}/${f}`)
    .filter((f) => {
      try {
        return Boolean(statSync(f).mode & 0o111)
      } catch {
        return false
      }
    })
}

/**
 * Guard 1 body, shared by the V1 and V2 hooks. Records the violation, then
 * throws so the dispatch is refused. Record-before-throw means a host that
 * swallows the error is still detected at the next session start.
 *
 * `project` is precomputed by the caller because the two plugin flavours learn
 * the directory from different places (V1 hook input vs. V2 `ctx.location`).
 */
export function guardToolExecution(event: any, project?: string): void {
  const model = findModelViolation(event?.tool ?? event?.toolName, event?.input ?? event?.args ?? event?.toolInput)
  if (model === null) return
  const tool = String(event?.tool ?? event?.toolName ?? "subagent")
  recordViolation({
    model,
    tool,
    project,
    session: typeof event?.sessionID === "string" ? event.sessionID : undefined,
  })
  throw new Error(violationMessage(model))
}

/**
 * Guard 2 body, shared by the V1 and V2 hooks. Re-apply project patch scripts,
 * then report any model-override violations seen since the last session so a
 * non-blocking guard stays visible.
 */
export function runSessionStartTasks(directory: string): void {
  const label = projectLabel({ directory })
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30).toISOString()
  const violations = readViolationsSince(since)
  if (violations.length > 0) {
    const here = violations.filter((v) => v.project === label)
    const elsewhere = violations.length - here.length
    console.warn(
      `[agent-guard] ${violations.length} subagent model override(s) in the last 30 days ` +
        `(${here.length} in ${label}` +
        (elsewhere > 0 ? `, ${elsewhere} in other projects` : "") +
        `). Latest: ${violations[violations.length - 1].model} ` +
        `in ${violations[violations.length - 1].project ?? "unknown"}. ` +
        `If these were NOT blocked, the guard is not enforcing — see ${violationsLog()}.`,
    )
  }

  for (const script of patchScriptsIn(directory)) {
    try {
      const out = execFileSync("bash", [script], { encoding: "utf8", timeout: 30_000 })
      const status = out.split("\n").find((l) => l.includes("status:"))?.trim()
      if (status) console.log(`[agent-guard] ${script.split("/").pop()}: ${status}`)
    } catch (err) {
      console.warn(`[agent-guard] ${script} failed: ${(err as Error).message}`)
    }
  }
}

/**
 * The directory a V2 `session.created` event belongs to, or undefined when the
 * event is a different type or carries no usable directory.
 */
export function sessionDirectory(event: any, fallback?: string): string | undefined {
  if (event?.type !== "session.created") return undefined
  const dir = event?.properties?.info?.directory ?? fallback
  return typeof dir === "string" && dir !== "" ? dir : undefined
}

/** V1 entrypoint. OpenCode 1.x reads `server()` and uses the returned hooks. */
export const server = async () => ({
  /**
   * Guard 1. Throwing from the hook refuses the dispatch; the violation is
   * logged first so a swallowed error is still reported at the next session
   * start.
   *
   * V1 delivers the tool name on `input.tool` and the arguments on
   * `output.args` (not `input.args`), so both are passed through to the shared
   * guard.
   */
  "tool.execute.before": async (input: any, output: any) => {
    guardToolExecution(
      {
        tool: input?.tool ?? input?.toolName,
        input: output?.args ?? input?.toolInput ?? input?.args,
        sessionID: input?.sessionID,
      },
      projectLabel(input),
    )
  },

  /** Guard 2. */
  "session.created": async (input: any) => {
    const dir: string = input?.directory ?? input?.cwd ?? input?.projectDir ?? process.cwd()
    runSessionStartTasks(dir)
  },
})

/**
 * V2 entrypoint. OpenCode 2 reads the default export's `id` and `setup()` and
 * ignores `server()`. V1 (>= 1.18.29) also calls `setup()`, but with a context
 * that lacks the V2 domains, so this returns early and V1 is served entirely by
 * `server()`.
 */
export async function setup(ctx: any): Promise<void | (() => void)> {
  const hasToolHook = ctx?.tool && typeof ctx.tool.hook === "function"
  const hasEventStream = ctx?.event && typeof ctx.event.subscribe === "function"
  // Not a V2 context (V1 calls setup() without these domains): server() owns it.
  if (!hasToolHook && !hasEventStream) return

  const locationDir: string | undefined =
    typeof ctx?.location?.directory === "string" ? ctx.location.directory : undefined
  const project = locationDir ? projectLabel({ directory: locationDir }) : undefined

  // Guard 1: refuse any subagent dispatch that carries an explicit model.
  // Throwing from `execute.before` is the documented way for a V2 hook to
  // block a tool call.
  if (hasToolHook) {
    await ctx.tool.hook("execute.before", (event: any) => {
      guardToolExecution(event, project)
    })
  }

  // Guard 2: once per session, from the public event stream.
  if (!hasEventStream) return
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const dir = sessionDirectory(event, locationDir)
        if (dir) runSessionStartTasks(dir)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.warn(`[agent-guard] event subscription failed: ${(err as Error).message}`)
      }
    }
  })()
  return () => controller.abort()
}

export default {
  id: "opencode-agent-guard",
  server,
  setup,
}
