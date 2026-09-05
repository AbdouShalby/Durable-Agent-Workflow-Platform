export function databaseUrl(): string {
  const value = process.env['DATABASE_URL'];
  if (!value) throw new Error('DATABASE_URL is required');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('PostgreSQL DATABASE_URL required');
  return value;
}
export function port(): number {
  const value = process.env['PORT'] ?? '8080';
  if (!/^\d+$/.test(value) || Number(value) > 65535) throw new Error('PORT must be 0..65535');
  return Number(value);
}
