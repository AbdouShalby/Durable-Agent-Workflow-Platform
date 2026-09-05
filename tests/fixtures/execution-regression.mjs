// Explicit loader-only negative controls. Never loaded by production entrypoints.
import { registerHooks } from 'node:module';
const mode = process.env.DAW_EXECUTION_MUTATION;
const replace = (source, from, to, count = 1) => {
  if (source.split(from).length !== count + 1) throw new Error(`mutation target changed: ${mode}`);
  return source.replaceAll(from, to);
};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (!url.endsWith('dist/src/application/execution.js')) return loaded;
  let source = String(loaded.source);
  switch (mode) {
    case 'claim':
      // Replace lock+conditional claim with genuinely unsafe read-then-write.
      // A test-only DB sleep exposes the read/write window reliably, not by luck.
      source = replace(source, 'FOR UPDATE OF r SKIP LOCKED', '', 2);
      source = replace(source, 'AND available_at<=clock_timestamp() ORDER BY ordinal FOR UPDATE LIMIT 1',
        'AND available_at<=clock_timestamp() ORDER BY ordinal LIMIT 1');
      source = replace(source, 'const claimed = (await client.query', "await client.query('SELECT pg_sleep(0.2)'); const claimed = (await client.query");
      source = replace(source, "WHERE run_id=$1 AND step_key=$2 AND state='READY' AND attempt_count<max_attempts", 'WHERE run_id=$1 AND step_key=$2 AND attempt_count<max_attempts');
      break;
    case 'fence':
      source = replace(source, 'AND owner=$3 AND fence=$4', 'AND $3::uuid IS NOT NULL AND $4::integer IS NOT NULL'); break;
    case 'expiry':
      source = replace(source, 'AND lease_expires_at>clock_timestamp() AND deadline_at>clock_timestamp()', ''); break;
    case 'recovery':
      source = replace(source, 'export async function recoverOne(pool) {', 'export async function recoverOne(pool) { return false;'); break;
    case 'retry-limit':
      source = replace(source, 'step.attempt_count < step.max_attempts', 'true'); break;
    default: throw new Error('unknown execution mutation');
  }
  return { ...loaded, source };
} });
