import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { BACKEND_DATABASE_FILE } from '../../../common/platform/backendNames';

/** AionCore v0.2.2 stores the resume anchor outside conversation.extra.
 * Read only that binding; the backend remains the sole database writer.
 */
export function sessionBinding(dataDir: string, conversationId: string, agentId: string): string {
  const db = new DatabaseSync(join(dataDir, BACKEND_DATABASE_FILE), { readOnly: true });
  try {
    const row = db
      .prepare('SELECT session_id FROM acp_session WHERE conversation_id = ? AND agent_id = ?')
      .get(conversationId, agentId);
    return typeof row?.session_id === 'string' ? row.session_id : '';
  } finally {
    db.close();
  }
}

/** The other way round: the conversation an adapter session belongs to. Empty when there is none (yet). */
export function conversationOfSession(dataDir: string, sessionId: string): string {
  const db = new DatabaseSync(join(dataDir, BACKEND_DATABASE_FILE), { readOnly: true });
  try {
    const row = db.prepare('SELECT conversation_id FROM acp_session WHERE session_id = ?').get(sessionId);
    return typeof row?.conversation_id === 'string' ? row.conversation_id : '';
  } finally {
    db.close();
  }
}
