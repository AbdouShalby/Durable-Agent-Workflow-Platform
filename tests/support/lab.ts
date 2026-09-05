import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createPool } from '../../src/persistence/database.js';

export async function waitFor<T>(probe: () => Promise<T | false> | T | false, label: string, ms = 7000): Promise<T> {
  const deadline = performance.now() + ms;
  do {
    const result = await probe();
    if (result !== false) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (performance.now() < deadline);
  throw new Error(`timeout: ${label}`);
}
async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  return address.port;
}
export interface OwnedProcess {
  child: ChildProcess; role: string; output: string; failure?: string;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
}
export class Lab {
  readonly children: OwnedProcess[] = [];
  readonly token = randomBytes(32).toString('hex');
  directory = '';
  url = '';
  readonly pgBin = process.env['PG_BIN'] ?? '/usr/lib/postgresql/18/bin';
  postgres: OwnedProcess | undefined;

  child(role: string, executable: string, args: string[], env = process.env, ipc = false): OwnedProcess {
    const child = spawn(executable, args, { env, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
    const owned: OwnedProcess = { child, role, output: '' };
    child.stdout?.on('data', (b: Buffer) => { owned.output = (owned.output + b.toString()).slice(-20000); });
    child.stderr?.on('data', (b: Buffer) => { owned.output = (owned.output + b.toString()).slice(-20000); });
    child.on('error', e => { owned.failure = e.message; });
    child.on('close', (code, signal) => { owned.exit = { code, signal }; });
    this.children.push(owned); return owned;
  }
  async startPostgres(): Promise<void> {
    assert.notEqual(process.platform, 'win32', 'real integration tests require Linux/WSL');
    assert.notEqual(process.getuid?.(), 0, 'run isolated PostgreSQL as a non-root user');
    this.directory = await mkdtemp(path.join(tmpdir(), 'daw1-pg-'));
    const data = path.join(this.directory, 'data'), socket = path.join(this.directory, 'socket');
    await mkdir(socket);
    execFileSync(path.join(this.pgBin, 'initdb'), ['-D', data, '--username=daw_test', '--auth-local=trust',
      '--auth-host=trust', '--encoding=UTF8', '--no-locale'], { stdio: 'pipe' });
    const port = await unusedPort();
    this.url = `postgresql://daw_test@127.0.0.1:${port}/postgres`;
    this.postgres = this.child('postgres', path.join(this.pgBin, 'postgres'), ['-D', data, '-h', '127.0.0.1',
      '-p', String(port), '-k', socket, '-c', 'fsync=on', '-c', 'synchronous_commit=on']);
    const owned = this.postgres;
    await waitFor(() => {
      if (owned.failure || owned.exit) throw new Error(`owned PostgreSQL startup failed: ${owned.failure ?? owned.output}`);
      return owned.output.includes('database system is ready to accept connections');
    }, 'owned PostgreSQL readiness', 15000);
    const pool = createPool(this.url, 'daw-identity-check');
    try {
      const result = await pool.query<{ data_directory: string; fsync: string; synchronous_commit: string }>(
        "SELECT current_setting('data_directory') AS data_directory, current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit");
      assert.deepEqual(result.rows[0], { data_directory: data, fsync: 'on', synchronous_commit: 'on' });
    } finally { await pool.end(); }
  }
  async startApi(approverToken = ''): Promise<{ url: string; process: OwnedProcess }> {
    const owned = this.child('api', process.execPath, ['dist/src/entrypoints/api.js'], {
      ...process.env, DATABASE_URL: this.url, PORT: '0', OPERATOR_TOKEN: this.token, APPROVER_TOKEN: approverToken,
    });
    const url = await waitFor(() => {
      if (owned.failure || owned.exit) throw new Error(`API startup failed: ${owned.failure ?? owned.output}`);
      for (const line of owned.output.split('\n')) {
        if (!line.startsWith('{')) continue;
        const entry = JSON.parse(line) as { event?: string; url?: string };
        if (entry.event === 'listening' && entry.url) return entry.url;
      }
      return false;
    }, 'API listening');
    return { url, process: owned };
  }
  async restartPostgres(): Promise<void> {
    const old = this.postgres; assert.ok(old);
    await this.stop(old, 'SIGINT');
    const owned = this.child('postgres-restart', old.child.spawnfile, old.child.spawnargs.slice(1));
    this.postgres = owned;
    await waitFor(() => {
      if (owned.failure || owned.exit) throw new Error('owned PostgreSQL restart failed');
      return owned.output.includes('database system is ready to accept connections');
    }, 'same-cluster PostgreSQL restart', 15000);
  }
  async stop(owned: OwnedProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    if (!owned.exit && !owned.failure) {
      assert.equal(owned.child.kill(signal), true);
      await waitFor(() => owned.exit ?? false, `${owned.role} exit`, 10000);
    }
  }
  async cleanup(): Promise<void> {
    const failures: unknown[] = [];
    for (const owned of [...this.children].reverse()) {
      try { await this.stop(owned, owned.role.startsWith('postgres') ? 'SIGINT' : 'SIGTERM'); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'owned process cleanup failed');
    assert.ok(this.children.every(p => p.exit || p.failure));
    // Keep the owned temporary cluster and logs for inspection; never delete user data.
  }
}
