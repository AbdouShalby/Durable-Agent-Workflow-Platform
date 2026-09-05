import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Deliberately bounded offline hygiene checks, not a credential-validity oracle.
export function scanText(file, text) {
  const findings = [];
  const add = (line, rule) => findings.push({ file, line, rule });
  if (/(^|\/)\.env(?:\.|$)/.test(file)) add(1, 'tracked-env-file');
  text.split(/\r?\n/).forEach((line, index) => {
    const n = index + 1;
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) add(n, 'private-key');
    if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9]{20,})/.test(line)) add(n, 'provider-token');
    if (/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=-]{8,}/.test(line)) add(n, 'literal-authorization');
    for (const match of line.matchAll(/[a-z][a-z0-9+.-]*:\/\/([^\s/"'`]+)@/gi)) {
      const userinfo = match[1];
      const colon = userinfo.indexOf(':');
      if (colon >= 0 && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(userinfo.slice(colon + 1))) add(n, 'literal-url-password');
    }
    // Literal assignments in JS/JSON/YAML/shell and Compose default interpolation.
    const assignment = line.match(/(?:^|[\s{,])['"]?([\w-]*(?:password|passwd|secret|token|api[_-]?key))['"]?\s*[:=]\s*(['"])([^'"\r\n]*)\2/i);
    if (assignment && assignment[3] && !/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::\?[^}]*)?\}$/.test(assignment[3])) add(n, 'literal-credential-assignment');
    const yaml = line.match(/^\s*(?:-\s*)?(['"]?)([\w-]*(?:password|passwd|secret|token|api[_-]?key))\1\s*[:=]\s*([^\s'"#][^#]*)/i);
    if (yaml && !/^\$\{[A-Za-z_][A-Za-z0-9_]*(?::\?[^}]*)?\}\s*$/.test(yaml[3])) add(n, 'literal-config-credential');
  });
  return findings;
}

export function checkCompose(text) {
  const rows = text.split(/\r?\n/).filter(line => !/^\s*#/.test(line));
  const matches = rows.filter(line => /^\s*POSTGRES_PASSWORD:/.test(line));
  const ports = rows.filter(line => /^\s*ports:/.test(line));
  return matches.length === 1 && /^\s*POSTGRES_PASSWORD:\s*\$\{DAW_DB_PASSWORD:\?[^}]*\}\s*$/.test(matches[0])
    && ports.length === 1 && /^\s*ports:\s*\["127\.0\.0\.1:15432:5432"\]\s*$/.test(ports[0]);
}

export function scanRepository(history = false) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const findings = []; let files = 0;
  if (history) {
    const seen = new Set();
    for (const revision of git('rev-list', '--all').trim().split(/\s+/)) {
      for (const row of git('ls-tree', '-rz', revision).split('\0').filter(Boolean)) {
        const match = row.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/s);
        if (!match) continue;
        const [, oid, file] = match; const identity = `${file}:${oid}`;
        if (seen.has(identity)) continue;
        seen.add(identity); files++;
        findings.push(...scanText(file, git('cat-file', 'blob', oid)).map(f => ({ ...f, revision })));
      }
    }
  } else {
    for (const file of new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))) {
      files++; findings.push(...scanText(file, readFileSync(file, 'utf8')));
    }
    if (!checkCompose(readFileSync('compose.yml', 'utf8'))) findings.push({ file: 'compose.yml', line: 1, rule: 'required-compose-contract' });
  }
  return { mode: history ? 'reachable-history' : 'working-tree', files, findings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).some(arg => arg !== '--history') || process.argv.length > 3) throw new Error('Only --history is supported');
  const report = scanRepository(process.argv.includes('--history'));
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
