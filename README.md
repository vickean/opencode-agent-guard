# opencode-agent-guard

Guards for agent-driven coding sessions, as a global OpenCode plugin.

## What it does

**1. Blocks subagent dispatches that carry an explicit `model`.**

Each agent's model is chosen by `agent.<name>.model` in `opencode.json`. Passing
`model:` on a subagent dispatch silently overrides that pin — and nothing reports
the override. The operator's configured model simply stops being used, with no
error and no signal, and the agent has no way to notice it is not running the
model the operator believes it is.

That is not hypothetical. It happened here: the SDD skill ships the instruction
*"Always specify the model explicitly when dispatching a subagent"*, and following
it overrode the pin on every dispatch until it was caught by hand.

**2. Re-applies project patch scripts at session start.**

Plugin install paths encode the upstream commit
(`~/.cache/opencode/npm/git-<plugin>-<commit>/…`), so every plugin update lands a
fresh directory and discards any local edit. Any project can ship a repair script
at `scripts/patches/*.sh`; this hook runs the executable ones on every session
start, which is exactly when an update has landed.

Example: `ocr-cat`'s `scripts/patches/apply-sdd-model-selection-patch.sh`, which
re-applies the SDD model-selection patch after each `superpowers` update.

## Install

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "opencode-agent-guard@git+https://github.com/vickean/opencode-agent-guard.git"
  ]
}
```

Restart OpenCode. There is nothing else to configure.

## The honest limit

The block is implemented by throwing from a `tool.execute.before` hook. **Whether
OpenCode surfaces a thrown hook error as a blocking failure, or swallows it, is
not verified** — that needs an installed plugin and a restart to observe, and the
plugin API ships no type definitions at the paths checked while building it.

So the plugin does not rely on the block alone. Every violation is appended to
`~/.local/state/opencode-agent-guard/violations.log`, and `session.created` reads
that log back and warns about violations in the last 30 days:

```
[agent-guard] 3 subagent model override(s) recorded in the last 30 days
(latest: expensive/big). If these were NOT blocked, the guard is not enforcing.
```

If the block silently fails, you find out at the next session start rather than
never. A guard whose own failure is silent is worse than no guard, because it
looks like protection.

To test enforcement after installing, deliberately dispatch a subagent with a
`model:` and check whether the call is refused.

## Violations log

One JSON object per line:

```json
{"at":"2026-10-07T05:20:00.000Z","model":"provider/model","tool":"subagent","project":"ocr-cat","session":"ses_abc"}
```

`project` is carried because the log is **per-machine, not per-project** — on a
shared machine, a violation in one repo has to be distinguishable from a violation
in another, or the session-start warning reports an unattributable count. The
warning splits the count accordingly:

```
[agent-guard] 5 subagent model override(s) in the last 30 days (2 in ocr-cat,
3 in other projects). Latest: provider/model in foresight-accounting. ...
```

Torn lines are skipped rather than failing a session.

## Scope

The guard is **global**: every project on the machine is covered, because the
operator's model pin is global config and the override risk is global. Guard 2
(patch re-apply) is inert outside projects that actually have `scripts/patches/`.

Expect this to affect other agents on the same machine, including ones mid-run.
An agent following a skill that says "always specify the model explicitly" will be
blocked and will re-dispatch on the configured model instead — which is the
intended correction, but it is still a behaviour change for that session.

## Tests

```bash
npm test
```

15 tests, `node --test`, no dependencies. Covers the violation detector (present,
null, blank, wrong-tool, malformed input), the log write path, project
attribution, timestamp filtering, torn-line tolerance, and patch-script discovery.

## Files

| Path | Purpose |
|---|---|
| `plugin.ts` | Hooks plus the pure, testable helpers they delegate to |
| `plugin.test.ts` | `node --test` suite |
| `opencode.json` | Example config, mirroring the opencode-timestamp convention |