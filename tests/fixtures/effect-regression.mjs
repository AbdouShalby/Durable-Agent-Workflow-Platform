// Explicit negative controls; loaded only by the test runner, never application configuration.
import { registerHooks } from 'node:module';
const mode = process.env.DAW_EFFECT_MUTATION;
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw new Error(`effect mutation target changed: ${mode}`);
  return source.replace(from, to);
};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  let source = String(loaded.source), changed = false;
  if (mode === 'effect-key' && url.endsWith('/src/simulator/server.js')) {
    source = replace(source, "const key = contract === 'keyed' ? body.effectKey : null;", 'const key = null;'); changed = true;
  }
  if (url.endsWith('/src/application/effects.js')) {
    if (mode === 'timeout') {
      source = replace(source, "UPDATE tool_invocations SET state='UNKNOWN',updated_at", "UPDATE tool_invocations SET state='PREPARED',updated_at"); changed = true;
    }
    if (mode === 'verification') {
      source = replace(source, "else if (verified.status !== 404)", 'else if (false)'); changed = true;
    }
    if (mode === 'unkeyed') {
      source = replace(source, "if (row.contract !== 'keyed')", 'if (false)'); changed = true;
    }
  }
  if (mode === 'unkeyed' && url.endsWith('/src/application/execution.js')) {
    source = replace(source, "tool.state === 'UNKNOWN' && tool.contract === 'unkeyed'", 'false'); changed = true;
  }
  return changed ? { ...loaded, source } : loaded;
} });
