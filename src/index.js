#!/usr/bin/env node
// stdout is reserved for ACP stream. Redirect logs to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { runAcp } from './run-acp.js';

runAcp();

// Keep process alive
process.stdin.resume();