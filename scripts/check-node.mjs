import { readFileSync } from 'node:fs';
const expected = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim();
if (process.versions.node !== expected) throw new Error(`Node ${expected} required; got ${process.versions.node}`);
