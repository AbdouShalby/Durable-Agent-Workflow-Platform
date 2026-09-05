// Test-only source mutations, never application configuration.
import { registerHooks } from 'node:module';
const mode = process.env.DAW_APPROVAL_MUTATION;
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw new Error(`approval mutation target changed: ${mode}`);
  return source.replace(from,to);
};
registerHooks({ load(url,context,nextLoad) {
  const loaded=nextLoad(url,context); let source=String(loaded.source),changed=false;
  if (url.endsWith('/src/application/approvals.js')) {
    if (mode==='fingerprint') { source=replace(source,'approval.action_fingerprint === actionFingerprint(action, policy)','true'); changed=true; }
    if (mode==='expiry') { source=replace(source,'if (!live) {','if (false) {'); changed=true; }
    if (mode==='authorization') { source=replace(source,'requireHuman(principal);',''); changed=true; }
    if (mode==='cancellation') { source=replace(source,"const uncertain = !!action && action.state !== 'PREPARED';",'const uncertain = false;'); changed=true; }
  }
  return changed ? {...loaded,source}:loaded;
} });
