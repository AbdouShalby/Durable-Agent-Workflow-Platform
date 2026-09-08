import { registerHooks } from 'node:module';
const mode=process.env.DAW_OPERATIONS_MUTATION;
const replace=(source,from,to)=>{if(source.split(from).length!==2)throw new Error(`operational mutation target changed: ${mode}`);return source.replace(from,to);};
registerHooks({load(url,context,nextLoad){const loaded=nextLoad(url,context);let source=String(loaded.source),changed=false;
  if(url.endsWith('/src/operations.js')) {
    if(mode==='readiness'){source=replace(source,'return result.rows[0]?.ready === true;','return true;');changed=true;}
    if(mode==='shutdown'){source=replace(source,'process.exit(1);','/* broken: no shutdown deadline exit */');changed=true;}
    if(mode==='telemetry'){source=replace(source,'schema_version: 1,','schema_version: 1, run_id: "unbounded-label",');changed=true;}
  }
  if(url.endsWith('/src/http.js')&&mode==='capacity'){source=replace(source,'inFlight >= operationalPolicy.maxInFlight','false');changed=true;}
  if(url.endsWith('/src/persistence/database.js')&&mode==='outage'){source=replace(source,"pool.on('connect', client => client.on('error', () => console.error(JSON.stringify({ event: 'database-client-error' }))));",'');changed=true;}
  return changed?{...loaded,source}:loaded;
}});
