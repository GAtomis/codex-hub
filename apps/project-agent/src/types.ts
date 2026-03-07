export type AgentState = {
  offsets: Record<string, number>;
};

export type NormalizedEvent = {
  eventId: string;
  threadId: string;
  turnId?: string;
  type: string;
  status?: string;
  title?: string;
  errorMessage?: string;
  timestamp: string;
  payload: Record<string, unknown>;
};
