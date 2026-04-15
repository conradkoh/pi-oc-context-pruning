import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * OpenCode-compatible pruning thresholds.
 *
 * PRUNE_PROTECT  – recency window. The most recent ~40 k tokens of tool
 *                  results are never touched so the agent always has fresh
 *                  context of its latest actions.
 *
 * PRUNE_MINIMUM  – hysteresis guard. If we'd only free a tiny amount,
 *                  pruning isn't worth the overhead of rebuilding context.
 *
 * PRUNE_PROTECTED_TOOLS – tool names whose results are never cleared.
 *                  "skill" results contain injected instructions the agent
 *                  needs for the rest of the session.
 */
const PRUNE_PROTECT = 40_000;
const PRUNE_MINIMUM = 20_000;
const PRUNE_PROTECTED_TOOLS = ["skill"];

const PLACEHOLDER = "[Old tool result content cleared]";
const STATUS_KEY = "oc-pruning";

/**
 * Rough token estimate: ~4 characters per token.
 * This matches the heuristic used by OpenCode's Token.estimate().
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export default function (pi: ExtensionAPI) {
  /**
   * The `context` event fires before every LLM call and provides a deep copy
   * of the current message list.  We can safely modify and return it without
   * touching the underlying session storage — pruning is entirely ephemeral
   * from the session's point of view.
   *
   * Algorithm (mirrors opencode/src/session/compaction.ts):
   *
   * 1. Walk messages in reverse (newest → oldest).
   * 2. Skip the two most-recent user turns completely.
   * 3. Stop at a CompactionSummary — everything before it was already
   *    summarised and is not present in the context window anyway.
   * 4. Accumulate token estimates for every tool result.
   * 5. Once accumulated tokens exceed PRUNE_PROTECT (40 k), all older
   *    tool results become pruning candidates.
   * 6. If total prunable tokens exceed PRUNE_MINIMUM (20 k), replace the
   *    content of those tool results with the placeholder text and strip
   *    any image attachments.
   */
  pi.on("context", (_event, ctx) => {
    const messages = _event.messages;

    let total = 0; // Running count of ALL tool-result tokens seen
    let pruned = 0; // Running count of tokens selected for pruning
    const toPrune: number[] = []; // Message indices to clear
    let turns = 0; // User turns encountered while walking backwards

    outer: for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];

      // Track user turns for the recency guard
      if (msg.role === "user") turns++;

      // Always skip the two most-recent user turns
      if (turns < 2) continue;

      // A compaction summary marks the beginning of what the LLM can see.
      // Everything before it has already been distilled — stop here.
      if (msg.role === "compactionSummary") break outer;

      if (msg.role === "toolResult") {
        // Never clear results from protected tools
        if (PRUNE_PROTECTED_TOOLS.includes(msg.toolName)) continue;

        // Estimate tokens from the text portions of the result
        const text = msg.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");

        const estimate = estimateTokens(text);
        total += estimate;

        // Only queue for pruning once we've passed the recency window
        if (total > PRUNE_PROTECT) {
          pruned += estimate;
          toPrune.push(i);
        }
      }
    }

    // Nothing worth pruning — leave messages untouched
    if (pruned <= PRUNE_MINIMUM) {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "");
      return;
    }

    // Apply pruning: replace content with placeholder, drop image attachments
    for (const i of toPrune) {
      const msg = messages[i];
      if (msg.role === "toolResult") {
        msg.content = [{ type: "text", text: PLACEHOLDER }];
      }
    }

    if (ctx.hasUI) {
      const kb = Math.round(pruned / 1000);
      ctx.ui.setStatus(
        STATUS_KEY,
        `OC-pruned ${toPrune.length} tool result(s) (~${kb}k tokens freed)`
      );
    }

    return { messages };
  });
}
