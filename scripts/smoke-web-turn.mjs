// Explicit production acceptance probe. Creates a short-lived local session,
// sends one Web-only request, then deletes that session even on failure.
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { signSessionToken } from '../dist/auth.js';
if (process.argv[2] !== '--apply')
  throw new Error('Use --apply to send the Web acceptance request');
const chatJid = process.argv[3] || 'web:main';
if (!chatJid.startsWith('web:') || chatJid.includes('#'))
  throw new Error('Use a Web workspace');
const db = new Database('data/db/messages.db', { fileMustExist: true });
const token = crypto.randomBytes(32).toString('hex');
const started = new Date().toISOString();
const marker = `IM_RELEASE_SMOKE_${crypto.randomBytes(8).toString('hex')}`;
try {
  const group = db
    .prepare('SELECT created_by FROM registered_groups WHERE jid=?')
    .get(chatJid);
  if (!group?.created_by) throw new Error('Workspace owner unavailable');
  db.prepare(
    `INSERT INTO user_sessions(id,user_id,ip_address,user_agent,created_at,expires_at,last_active_at)
    VALUES(?,?,'127.0.0.1','happyclaw-release-acceptance',?,?,?)`,
  ).run(
    token,
    group.created_by,
    started,
    new Date(Date.now() + 300000).toISOString(),
    started,
  );
  const response = await fetch('http://127.0.0.1:3000/api/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `happyclaw_session=${signSessionToken(token)}`,
      origin: 'http://127.0.0.1:3000',
    },
    body: JSON.stringify({
      chatJid,
      content: `这是部署验收，请只回复 ${marker}。本轮只在 Web 回复。`,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(`Message admission HTTP ${response.status}`);
  const admitted = await response.json();
  console.log(
    JSON.stringify({
      admitted: true,
      chatJid,
      marker,
      messageId: admitted.id ?? admitted.message?.id,
    }),
  );
  for (let i = 0; i < 90; i++) {
    const rows = db
      .prepare(
        `SELECT id,content,source_kind,finalization_reason FROM messages
      WHERE chat_jid=? AND is_from_me=1 AND timestamp>=? ORDER BY timestamp`,
      )
      .all(chatJid, started);
    const reply = rows.find(
      (r) => r.content?.trim() === marker || r.finalization_reason === 'error',
    );
    if (reply) {
      const exactMatch = reply.content.trim() === marker;
      console.log(
        JSON.stringify({
          exactMatch,
          sourceKind: reply.source_kind,
          finalizationReason: reply.finalization_reason,
          elapsedMs: Date.now() - Date.parse(started),
        }),
      );
      if (!exactMatch) process.exitCode = 1;
      break;
    }
    if (i === 89) throw new Error('No terminal Web reply within 180 seconds');
    await delay(2000);
  }
} finally {
  db.prepare('DELETE FROM user_sessions WHERE id=?').run(token);
  db.close();
}
