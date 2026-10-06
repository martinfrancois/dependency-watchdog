#!/usr/bin/env node
import { runMirror } from "./tumbleweed-mirror.ts";
runMirror().catch((error: unknown) => { console.error((error as Error).message); process.exitCode = 1; });
