import { executionLoop } from './execution-loop.js';
executionLoop('worker').catch(() => { console.error('worker startup/shutdown failed'); process.exitCode = 1; });
