import { executionLoop } from './execution-loop.js';
executionLoop('scheduler').catch(() => { console.error('scheduler startup/shutdown failed'); process.exitCode = 1; });
