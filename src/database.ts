import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { ProxyMessage, MessageSummary, SSEChunk } from './types';

/** Flush _responseBodyParts into responseBody and clean up */
function flushResponseBodyParts(msg: ProxyMessage): void {
  if (msg._responseBodyParts && msg._responseBodyParts.length > 0) {
    msg.responseBody += msg._responseBodyParts.join('');
    msg._responseBodyParts = undefined;
  }
}

/** Convert a DB row to a ProxyMessage object */
function rowToMessage(row: any): ProxyMessage {
  return {
    id: row.id,
    seq: row.seq,
    timestamp: row.timestamp,
    updatedAt: row.updated_at,
    method: row.method,
    url: row.url,
    path: row.path,
    requestHeaders: JSON.parse(row.request_headers),
    requestBody: row.request_body,
    responseStatus: row.response_status,
    responseHeaders: JSON.parse(row.response_headers),
    responseBody: row.response_body,
    isSSE: row.is_sse === 1,
    sseChunks: [],  // loaded separately via getSSEChunks
    duration: row.duration,
    proxyMode: row.proxy_mode || undefined,
  };
}

/** Convert a DB row to a MessageSummary object */
function rowToSummary(row: any): MessageSummary {
  return {
    id: row.id,
    seq: row.seq,
    timestamp: row.timestamp,
    updatedAt: row.updated_at,
    method: row.method,
    url: row.url,
    path: row.path,
    responseStatus: row.response_status,
    isSSE: row.is_sse === 1,
    duration: row.duration,
    proxyMode: row.proxy_mode || undefined,
  };
}

export class MessageDatabase {
  private db: Database.Database;

  private stmts!: {
    insertMessage: Database.Statement;
    insertSSEChunk: Database.Statement;
    deleteMessage: Database.Statement;
    getMessage: Database.Statement;
    getSummaries: Database.Statement;
    getSummariesAfter: Database.Statement;
    getAllMessages: Database.Statement;
    getSSEChunks: Database.Statement;
    getMeta: Database.Statement;
    setMeta: Database.Statement;
    clearMessages: Database.Statement;
    clearSSEChunks: Database.Statement;
  };

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('cache_size = -64000');

    this.runMigrations();
    this.prepareStatements();
  }

  private runMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT PRIMARY KEY,
        seq           INTEGER NOT NULL,
        timestamp     INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        method        TEXT NOT NULL,
        url           TEXT NOT NULL,
        path          TEXT NOT NULL,
        request_headers  TEXT NOT NULL,
        request_body     TEXT NOT NULL,
        response_status  INTEGER NOT NULL,
        response_headers TEXT NOT NULL,
        response_body    TEXT NOT NULL,
        is_sse           INTEGER NOT NULL DEFAULT 0,
        duration         INTEGER NOT NULL DEFAULT 0,
        proxy_mode       TEXT
      );

      CREATE TABLE IF NOT EXISTS sse_chunks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        timestamp  INTEGER NOT NULL,
        data       TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_messages_updated_at ON messages(updated_at);
      CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq);
      CREATE INDEX IF NOT EXISTS idx_sse_chunks_message_id ON sse_chunks(message_id);
    `);
  }

  private prepareStatements(): void {
    this.stmts = {
      insertMessage: this.db.prepare(`
        INSERT INTO messages (id, seq, timestamp, updated_at, method, url, path,
          request_headers, request_body, response_status, response_headers,
          response_body, is_sse, duration, proxy_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      insertSSEChunk: this.db.prepare(`
        INSERT INTO sse_chunks (message_id, timestamp, data, seq)
        VALUES (?, ?, ?, ?)
      `),

      deleteMessage: this.db.prepare(`DELETE FROM messages WHERE id = ?`),

      getMessage: this.db.prepare(`
        SELECT * FROM messages WHERE id = ?
      `),

      getSummaries: this.db.prepare(`
        SELECT id, seq, timestamp, updated_at, method, url, path,
               response_status, is_sse, duration, proxy_mode
        FROM messages
        ORDER BY seq
      `),

      getSummariesAfter: this.db.prepare(`
        SELECT id, seq, timestamp, updated_at, method, url, path,
               response_status, is_sse, duration, proxy_mode
        FROM messages
        WHERE (timestamp > ? OR updated_at > ?)
        ORDER BY seq
      `),

      getAllMessages: this.db.prepare(`
        SELECT * FROM messages ORDER BY seq
      `),

      getSSEChunks: this.db.prepare(`
        SELECT timestamp, data FROM sse_chunks
        WHERE message_id = ? ORDER BY seq
      `),

      getMeta: this.db.prepare(`SELECT value FROM metadata WHERE key = ?`),
      setMeta: this.db.prepare(`
        INSERT INTO metadata (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),

      clearMessages: this.db.prepare(`DELETE FROM messages`),
      clearSSEChunks: this.db.prepare(`DELETE FROM sse_chunks`),
    };
  }

  // --- Write operations ---

  insertMessage(msg: ProxyMessage): void {
    flushResponseBodyParts(msg);
    const insertTx = this.db.transaction(() => {
      this.stmts.insertMessage.run(
        msg.id, msg.seq, msg.timestamp, msg.updatedAt,
        msg.method, msg.url, msg.path,
        JSON.stringify(msg.requestHeaders), msg.requestBody,
        msg.responseStatus, JSON.stringify(msg.responseHeaders), msg.responseBody,
        msg.isSSE ? 1 : 0, msg.duration, msg.proxyMode ?? null
      );
      for (let i = 0; i < msg.sseChunks.length; i++) {
        this.stmts.insertSSEChunk.run(msg.id, msg.sseChunks[i].timestamp, msg.sseChunks[i].data, i);
      }
    });
    insertTx();
  }

  deleteMessage(id: string): void {
    this.stmts.deleteMessage.run(id);
  }

  clear(): void {
    const clearTx = this.db.transaction(() => {
      this.stmts.clearSSEChunks.run();
      this.stmts.clearMessages.run();
    });
    clearTx();
  }

  // --- Read operations ---

  getMessage(id: string): ProxyMessage | undefined {
    const row = this.stmts.getMessage.get(id) as any;
    if (!row) return undefined;
    const msg = rowToMessage(row);
    if (msg.isSSE) {
      msg.sseChunks = this.getSSEChunks(id);
    }
    return msg;
  }

  /** Get summaries for messages NOT in the excludeIds set */
  getSummariesExcluding(excludeIds: string[]): MessageSummary[] {
    if (excludeIds.length === 0) {
      const rows = this.stmts.getSummaries.all() as any[];
      return rows.map(rowToSummary);
    }
    const placeholders = excludeIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, seq, timestamp, updated_at, method, url, path,
             response_status, is_sse, duration, proxy_mode
      FROM messages
      WHERE id NOT IN (${placeholders})
      ORDER BY seq
    `);
    const rows = stmt.all(...excludeIds) as any[];
    return rows.map(rowToSummary);
  }

  /** Get summaries after timestamp, excluding specific IDs */
  getSummariesAfterExcluding(after: number, excludeIds: string[]): MessageSummary[] {
    if (excludeIds.length === 0) {
      const rows = this.stmts.getSummariesAfter.all(after, after) as any[];
      return rows.map(rowToSummary);
    }
    const placeholders = excludeIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`
      SELECT id, seq, timestamp, updated_at, method, url, path,
             response_status, is_sse, duration, proxy_mode
      FROM messages
      WHERE (timestamp > ? OR updated_at > ?)
        AND id NOT IN (${placeholders})
      ORDER BY seq
    `);
    const rows = stmt.all(after, after, ...excludeIds) as any[];
    return rows.map(rowToSummary);
  }

  /** Get all full messages NOT in the excludeIds set, as an array */
  getAllMessagesExcluding(excludeIds: string[]): ProxyMessage[] {
    const msgs = this.getAllMessagesIteratorExcluding(excludeIds);
    return Array.from(msgs);
  }

  /** Get all full messages NOT in the excludeIds set, lazily iterated */
  getAllMessagesIteratorExcluding(excludeIds: string[]): IterableIterator<ProxyMessage> {
    let stmt: Database.Statement;
    let params: any[];

    if (excludeIds.length === 0) {
      stmt = this.stmts.getAllMessages;
      params = [];
    } else {
      const placeholders = excludeIds.map(() => '?').join(',');
      stmt = this.db.prepare(`
        SELECT * FROM messages WHERE id NOT IN (${placeholders}) ORDER BY seq
      `);
      params = [...excludeIds];
    }

    const self = this;
    return (function* () {
      for (const row of stmt.iterate(...params) as IterableIterator<any>) {
        const msg = rowToMessage(row);
        if (msg.isSSE) {
          msg.sseChunks = self.getSSEChunks(msg.id);
        }
        yield msg;
      }
    })();
  }

  /** Get recent completed messages for warm cache, ordered by seq DESC */
  getRecentMessages(limit: number): ProxyMessage[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages ORDER BY seq DESC LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    const msgs: ProxyMessage[] = [];
    for (const row of rows) {
      const msg = rowToMessage(row);
      if (msg.isSSE) {
        msg.sseChunks = this.getSSEChunks(msg.id);
      }
      msgs.push(msg);
    }
    // Return in ascending seq order
    return msgs.reverse();
  }

  getSSEChunks(messageId: string): SSEChunk[] {
    const rows = this.stmts.getSSEChunks.all(messageId) as any[];
    return rows.map(row => ({ timestamp: row.timestamp, data: row.data }));
  }

  // --- Metadata ---

  getMeta(key: string): string | undefined {
    const row = this.stmts.getMeta.get(key) as any;
    return row ? row.value : undefined;
  }

  setMeta(key: string, value: string): void {
    this.stmts.setMeta.run(key, value);
  }

  persistCounters(total: number, sse: number, errors: number, seq: number): void {
    const tx = this.db.transaction(() => {
      this.stmts.setMeta.run('db_total_count', String(total));
      this.stmts.setMeta.run('db_sse_count', String(sse));
      this.stmts.setMeta.run('db_error_count', String(errors));
      this.stmts.setMeta.run('seq_counter', String(seq));
    });
    tx();
  }

  close(): void {
    this.db.close();
  }
}
