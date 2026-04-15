# pi-oc-context-pruning

OpenCode-style context pruning for the [pi coding agent](https://shittycodingagent.ai).

Selectively clears old tool-result content before every LLM call, freeing context-window space without losing conversation structure or touching session storage.

---

## What it does

Before each LLM call the extension inspects the message list and replaces the text content of old tool results with:

```
[Old tool result content cleared]
```

The tool call itself is preserved — the conversation remains structurally valid for the API. Images attached to cleared results are also dropped.

The algorithm mirrors [opencode's `compaction.ts` pruning step](https://github.com/sst/opencode/blob/main/packages/opencode/src/session/compaction.ts):

| Constant | Value | Purpose |
|---|---|---|
| `PRUNE_PROTECT` | 40 000 tokens | Recency window — newest tool results are never cleared |
| `PRUNE_MINIMUM` | 20 000 tokens | Hysteresis guard — don't prune unless this many tokens would be freed |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | Tool names whose results are never cleared |

**Walk order:** newest → oldest messages  
**Turn guard:** the two most-recent user turns are skipped entirely  
**Stop condition:** halts at a compaction-summary message  
**Storage:** pruning is **ephemeral** — session files are never modified

---

## Install

```bash
# Global (all projects)
pi install git:github.com/conradkoh/pi-oc-context-pruning

# Project-local (shared with your team via .pi/settings.json)
pi install -l git:github.com/conradkoh/pi-oc-context-pruning

# Pin to a specific tag or commit
pi install git:github.com/conradkoh/pi-oc-context-pruning@v1.0.0

# Try without installing
pi -e git:github.com/conradkoh/pi-oc-context-pruning
```

Once installed you'll see a footer status line like:

```
OC-pruned 3 tool result(s) (~30k tokens freed)
```

whenever the extension clears old results in a turn.

---

## How it works (annotated)

```
Messages sent to LLM (newest → oldest):
  [user turn N]          ← turns=1, skip (turns < 2)
  [assistant N]          ← skip
  [user turn N-1]        ← turns=2, start accumulating
  [assistant N-1]
    tool:read  4 k tokens   total= 4k  (inside PROTECT window, keep)
    tool:grep  8 k tokens   total=12k  (inside PROTECT window, keep)
    tool:read  20k tokens   total=32k  (inside PROTECT window, keep)
    tool:bash  15k tokens   total=47k  ← EXCEEDS 40k → PRUNE CANDIDATE
  [user turn N-2]        ← turns=3
  [assistant N-2]
    tool:read  12k tokens   total=59k  ← PRUNE CANDIDATE
    tool:glob   3k tokens   total=62k  ← PRUNE CANDIDATE  (pruned=30k)

pruned=30k > PRUNE_MINIMUM(20k) → replace 3 results with placeholder
```

---

## Differences from OpenCode

| Aspect | OpenCode | This package |
|---|---|---|
| Storage | Persists `time.compacted` timestamp to SQLite | Ephemeral — only modifies the in-flight context copy |
| Re-runs | Previously compacted parts are skipped via timestamp | Algorithm re-runs fresh each turn (same results) |
| Integration | Part of the OpenCode session compaction service | Pi `context` event hook |
