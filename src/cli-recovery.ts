#!/usr/bin/env node
import { runRecovery } from "./recovery-runtime.ts";
runRecovery().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
