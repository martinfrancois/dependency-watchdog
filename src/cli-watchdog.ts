#!/usr/bin/env node
import { runWatchdog, handleFailure } from "./watchdog.ts";

runWatchdog().catch(handleFailure);
