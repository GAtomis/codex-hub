import type { NormalizedEvent } from "./types.js";

const chunk = <T>(list: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }
  return chunks;
};

export const reportEvents = async (args: {
  hubUrl: string;
  ingestApiKey?: string;
  project: { slug: string; name: string; path: string };
  events: NormalizedEvent[];
}): Promise<void> => {
  const batches = chunk(args.events, 80);

  for (const batch of batches) {
    const response = await fetch(`${args.hubUrl}/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(args.ingestApiKey ? { "x-api-key": args.ingestApiKey } : {})
      },
      body: JSON.stringify({
        project: args.project,
        events: batch
      })
    });

    if (!response.ok) {
      const content = await response.text();
      throw new Error(`failed to report events (${response.status}): ${content}`);
    }
  }
};
