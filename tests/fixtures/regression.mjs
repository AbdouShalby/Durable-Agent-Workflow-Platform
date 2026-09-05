// Deliberate, test-only source mutations. No application flag enables these.
import { registerHooks } from 'node:module';
const mode = process.env.DAW_TEST_MUTATION;
const mutations = {
  status: ['dist/src/http.js', 'result.created ? 202 : 200', '202'],
  fingerprint: ['dist/src/application/runs.js', 'run.request_fingerprint !== hash', 'false'],
  atomicity: ['dist/src/application/runs.js', 'const created = run !== undefined;',
    "await client.query('COMMIT'); await client.query('BEGIN'); const created = run !== undefined;"],
};
const mutation = mutations[mode];
if (!mutation) throw new Error('unknown test mutation');
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (!url.endsWith(mutation[0])) return result;
  const source = String(result.source);
  if (source.split(mutation[1]).length !== 2) throw new Error('mutation target changed');
  return { ...result, source: source.replace(mutation[1], mutation[2]) };
} });
