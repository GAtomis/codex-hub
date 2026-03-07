import { config } from "./config.js";
import { reportEvents } from "./reporter.js";
import { collectIncrementalEvents, listRecentJsonlFiles } from "./scanner.js";
import { loadState, saveState } from "./state.js";

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const runOnce = async (): Promise<void> => {
  const state = await loadState(config.stateFile);
  const files = await listRecentJsonlFiles(config.sessionsRoot, config.maxFiles);
  const { nextState, events } = await collectIncrementalEvents(files, state);

  if (events.length === 0) {
    await saveState(config.stateFile, nextState);
    // eslint-disable-next-line no-console
    console.log("[agent] no new events");
    return;
  }

  await reportEvents({
    hubUrl: config.hubUrl,
    ingestApiKey: config.ingestApiKey,
    project: {
      slug: config.projectSlug,
      name: config.projectName,
      path: config.projectPath
    },
    events
  });

  await saveState(config.stateFile, nextState);

  // eslint-disable-next-line no-console
  console.log(`[agent] reported ${events.length} events from ${files.length} files`);
};

const main = async (): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log("[agent] started", {
    projectSlug: config.projectSlug,
    sessionsRoot: config.sessionsRoot,
    hubUrl: config.hubUrl,
    scanIntervalMs: config.scanIntervalMs
  });

  while (true) {
    try {
      await runOnce();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("[agent] run failed", error);
    }

    if (config.runOnce) {
      break;
    }

    await sleep(config.scanIntervalMs);
  }
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("[agent] fatal", error);
  process.exit(1);
});
