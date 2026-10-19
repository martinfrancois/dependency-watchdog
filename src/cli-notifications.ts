#!/usr/bin/env node
import { runSweep } from "./notifications.ts";
runSweep().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
