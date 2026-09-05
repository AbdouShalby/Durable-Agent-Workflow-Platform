// Test-runner-only mutations. None are accepted as application configuration.
import { registerHooks } from 'node:module';
const mode = process.env.DAW_AGENT_MUTATION;
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw new Error(`agent mutation target changed: ${mode}`);
  return source.replace(from, to);
};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context); let source = String(loaded.source), changed = false;
  if (url.endsWith('/src/domain/agent.js')) {
    if (mode === 'output') { source = replace(source, 'if (!validateDecision(value))', 'if (false)'); changed = true; }
    if (mode === 'allowlist') { source = replace(source, 'registry.get(name)', "registry.get('incident-context')"); changed = true; }
  }
  if (url.endsWith('/src/application/agent.js')) {
    if (mode === 'checkpoint') {
      source = replace(source, 'const checkpoints = await owned(pool, claim, client => history(client, claim));',
        'const checkpoints = await owned(pool, claim, client => history(client, claim)).then(rows => claim.attempt_count > 1 ? [] : rows);'); changed = true;
    }
    if (mode === 'budget') { source = replace(source, 'if (turn > row.max_turns)', 'if (false)'); changed = true; }
  }
  return changed ? { ...loaded, source } : loaded;
} });
