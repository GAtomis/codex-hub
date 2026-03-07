import { readFile, writeFile } from "node:fs/promises";
import type { AgentState } from "./types.js";

const emptyState = (): AgentState => ({ offsets: {} });

export const loadState = async (stateFile: string): Promise<AgentState> => {
  try {
    const content = await readFile(stateFile, "utf8");
    const parsed = JSON.parse(content) as AgentState;
    if (!parsed || typeof parsed !== "object" || !parsed.offsets || typeof parsed.offsets !== "object") {
      return emptyState();
    }
    return parsed;
  } catch {
    return emptyState();
  }
};

export const saveState = async (stateFile: string, state: AgentState): Promise<void> => {
  await writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
};
