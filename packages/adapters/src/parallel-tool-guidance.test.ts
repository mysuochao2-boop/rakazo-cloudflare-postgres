import { parallelToolGuidanceEnabled } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  COMPUTER_BATCH_GUIDANCE,
  PARALLEL_TOOL_GUIDANCE,
  parallelToolGuidanceLine,
  userTurnInstructions,
} from "./executor.js";

const base = {
  botInstructions: "Bot instructions",
  groupContext: undefined,
  messagingContext: undefined,
  redactedMemoryContext: undefined,
  redactedScratchpadContext: undefined,
  hasHistoricalContext: false,
  computerInstruction: "Use computer_observe and computer_act for the desktop.",
  pageBrowserAllowed: false,
  workspaceInstruction: "ws",
  agentEnvironmentInstruction: undefined,
  botDirectory: undefined,
  pluginLine: undefined,
  agentSkillsLine: undefined,
  taughtSkillsLine: undefined,
  replyGuidance: "reply",
};

describe("parallel tool guidance (RAKAZO_PARALLEL_TOOL_GUIDANCE)", () => {
  it("is off by default and leaves instructions unchanged", () => {
    expect(parallelToolGuidanceEnabled({})).toBe(false);
    const without = userTurnInstructions(base).join("\n");
    expect(without).not.toContain(PARALLEL_TOOL_GUIDANCE);
  });

  it("adds parallel and computer batching guidance when enabled", () => {
    expect(parallelToolGuidanceEnabled({ RAKAZO_PARALLEL_TOOL_GUIDANCE: "1" })).toBe(true);
    const text = userTurnInstructions({ ...base, parallelToolGuidance: true }).join("\n");
    expect(text).toContain(PARALLEL_TOOL_GUIDANCE);
    expect(text).toContain(COMPUTER_BATCH_GUIDANCE);
  });

  it("omits computer batching guidance without computer tools", () => {
    expect(parallelToolGuidanceLine("You have a sandbox shell.")).toBe(PARALLEL_TOOL_GUIDANCE);
  });
});
