#!/usr/bin/env node
/**
 * Entry point. Wiring only; see cli-watchdog.ts for why this file is excluded from coverage.
 */
import { runPrune } from "./prune.ts";

runPrune().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
