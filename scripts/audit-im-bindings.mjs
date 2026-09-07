import Database from 'better-sqlite3';
import path from 'node:path';
const db = new Database(path.resolve('data/db/messages.db'), {
  readonly: true,
  fileMustExist: true,
});
try {
  const integrity = db.pragma('quick_check', { simple: true });
  const foreignKeys = db.pragma('foreign_key_check');
  if (integrity !== 'ok' || foreignKeys.length)
    throw new Error('Database integrity check failed');
  const routes = db
    .prepare(
      `SELECT ca.provider, ca.name, ca.transport_status,
    g.jid, g.target_agent_id, g.target_main_jid, g.created_by,
    a.kind, a.chat_jid, w.created_by AS workspace_owner
    FROM channel_accounts ca
    LEFT JOIN registered_groups g ON g.channel_account_id = ca.id
    LEFT JOIN agents a ON a.id = g.target_agent_id
    LEFT JOIN registered_groups w ON w.jid = COALESCE(a.chat_jid, g.target_main_jid)
    WHERE ca.enabled = 1`,
    )
    .all();
  const results = routes.map((r) => ({
    provider: r.provider,
    account: r.name,
    connected: r.transport_status === 'connected',
    bound:
      !!r.jid &&
      !!r.workspace_owner &&
      r.workspace_owner === r.created_by &&
      (!r.target_agent_id || r.kind === 'conversation') &&
      !!(r.target_agent_id || r.target_main_jid),
  }));
  console.log(JSON.stringify({ database: 'ok', routes: results }, null, 2));
  if (results.some((r) => !r.bound || !r.connected)) process.exitCode = 1;
} finally {
  db.close();
}
