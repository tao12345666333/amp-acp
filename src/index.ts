#!/usr/bin/env node
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

import { runAcp } from './run-acp.js';

runAcp();

process.stdin.resume();
