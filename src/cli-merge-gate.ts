#!/usr/bin/env node
import { runMergeGate } from "./merge-gate.ts";
runMergeGate().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
