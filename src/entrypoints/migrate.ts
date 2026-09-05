import { databaseUrl } from '../config.js';
import { createPool } from '../persistence/database.js';
import { migrate } from '../persistence/migrations.js';
const pool = createPool(databaseUrl(), 'daw-migrate');
try { await migrate(pool); console.log('Migrations applied and checksums verified'); }
catch { console.error('Migration failed; database changes rolled back'); process.exitCode = 1; }
finally { await pool.end(); }
