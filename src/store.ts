import { ProxyMessage, MessageSummary, SSEChunk, Stats } from './types';
import { v4 as uuidv4 } from 'uuid';
import { MessageDatabase } from './database';

/** Flush _responseBodyParts into responseBody and clean up */
function flushResponseBodyParts(msg: ProxyMessage): void {
  if (msg._responseBodyParts && msg._responseBodyParts.length > 0) {
    msg.responseBody += msg._responseBodyParts.join('');
    msg._responseBodyParts = undefined;
  }
}

/** Build a lightweight summary from a ProxyMessage */
function toSummary(msg: ProxyMessage): MessageSummary {
  return {
    id: msg.id,
    seq: msg.seq,
    timestamp: msg.timestamp,
    updatedAt: msg.updatedAt,
    method: msg.method,
    url: msg.url,
    path: msg.path,
    responseStatus: msg.responseStatus,
    isSSE: msg.isSSE,
    duration: msg.duration,
    proxyMode: msg.proxyMode,
  };
}

/**
 * Counter model:
 * - Metadata stores the TOTAL counts in the DB (all persisted messages, including those also in memory).
 * - In-memory, dbXxxCount represents "DB-only" counts (persisted messages NOT in the memory Map).
 * - getStats() = memSize + dbXxxCount = no double-counting.
 *
 * Transitions:
 * - createMessage(): add to mem, no DB change.
 * - updateMessage() with duration > 0: persist to DB. Message is in both places.
 *   Since mem already counts it (via messages.size), we do NOT increment dbXxxCount here.
 * - evictIfNeeded(): remove from mem → increment dbXxxCount (message is now DB-only).
 * - warmCache(): load from DB into mem → decrement dbXxxCount (message is no longer DB-only).
 * - persistCounters() on close: store (dbXxxCount + completedInMemory) as the total DB count,
 *   because those completed-in-memory messages are in the DB too.
 * - clear(): reset everything.
 */

class MessageStore {
  private messages: Map<string, ProxyMessage> = new Map();
  private seqCounter: number = 0;

  // Memory-layer counters (for messages in the Map)
  private memSseCount: number = 0;
  private memErrorCount: number = 0;

  // DB-only counters: persisted messages NOT currently in the memory Map
  private dbOnlyTotalCount: number = 0;
  private dbOnlySseCount: number = 0;
  private dbOnlyErrorCount: number = 0;

  private db: MessageDatabase | null = null;
  private inMemoryLimit: number = 100;

  /** Initialize the store with a SQLite database path.
   *  Must be called before first use. */
  init(dbPath: string, inMemoryLimit?: number): void {
    if (inMemoryLimit !== undefined) {
      this.inMemoryLimit = inMemoryLimit;
    }
    this.db = new MessageDatabase(dbPath);
    this.loadCountersFromDB();
    this.warmCache();
    console.log(`[Store] SQLite database initialized: ${dbPath} (in-memory limit: ${this.inMemoryLimit})`);
  }

  /** Close the database connection. Should be called before process exit. */
  close(): void {
    if (this.db) {
      this.persistCounters();
      this.db.close();
      this.db = null;
    }
    // Reset all in-memory state so the singleton can be re-initialized
    this.messages.clear();
    this.seqCounter = 0;
    this.memSseCount = 0;
    this.memErrorCount = 0;
    this.dbOnlyTotalCount = 0;
    this.dbOnlySseCount = 0;
    this.dbOnlyErrorCount = 0;
  }

  private ensureDb(): MessageDatabase {
    if (!this.db) throw new Error('Store not initialized. Call init() first.');
    return this.db;
  }

  /** Load seq counter and DB total counts from metadata.
   *  Metadata stores "total in DB" (including those also in memory).
   *  We then subtract the warm-cached messages to get "DB-only" counts. */
  private loadCountersFromDB(): void {
    const db = this.ensureDb();
    this.seqCounter = parseInt(db.getMeta('seq_counter') || '0', 10);
    // These are total DB counts (loaded before warmCache adjusts them)
    this.dbOnlyTotalCount = parseInt(db.getMeta('db_total_count') || '0', 10);
    this.dbOnlySseCount = parseInt(db.getMeta('db_sse_count') || '0', 10);
    this.dbOnlyErrorCount = parseInt(db.getMeta('db_error_count') || '0', 10);
  }

  /** On startup, load the most recent completed messages from DB into memory.
   *  Adjusts db-only counters because these messages are no longer DB-only. */
  private warmCache(): void {
    const db = this.ensureDb();
    const recentMsgs = db.getRecentMessages(this.inMemoryLimit);
    for (const msg of recentMsgs) {
      this.messages.set(msg.id, msg);
      if (msg.isSSE) this.memSseCount++;
      if (msg.responseStatus >= 400) this.memErrorCount++;
    }
    // These messages are now in memory, so subtract from DB-only counters
    this.dbOnlyTotalCount -= recentMsgs.length;
    for (const msg of recentMsgs) {
      if (msg.isSSE) this.dbOnlySseCount--;
      if (msg.responseStatus >= 400) this.dbOnlyErrorCount--;
    }
  }

  createMessage(partial: Omit<ProxyMessage, 'id' | 'timestamp' | 'seq' | 'updatedAt'>): ProxyMessage {
    const now = Date.now();
    const msg: ProxyMessage = {
      ...partial,
      id: uuidv4(),
      seq: ++this.seqCounter,
      timestamp: now,
      updatedAt: now,
    };
    if (msg.isSSE) this.memSseCount++;
    if (msg.responseStatus >= 400) this.memErrorCount++;
    this.messages.set(msg.id, msg);
    return msg;
  }

  updateMessage(id: string, updates: Partial<ProxyMessage>): void {
    const msg = this.messages.get(id);
    if (!msg) return;

    // Track counter changes before update
    const oldStatus = msg.responseStatus;
    const oldSSE = msg.isSSE;
    Object.assign(msg, updates, { updatedAt: Date.now() });

    // Update memory counters if relevant fields changed
    if (oldSSE !== msg.isSSE) {
      this.memSseCount += msg.isSSE ? 1 : -1;
    }
    if ((oldStatus >= 400) !== (msg.responseStatus >= 400)) {
      this.memErrorCount += msg.responseStatus >= 400 ? 1 : -1;
    }

    // Persist to SQLite once the message is complete (duration is set)
    if (updates.duration !== undefined && updates.duration > 0) {
      const db = this.ensureDb();
      db.insertMessage(msg);
      // Message is now in both memory and DB.
      // Since mem already counts it via messages.size, do NOT increment dbOnly counters.
      // If evictIfNeeded removes it from memory, it will increment dbOnly counters then.
      this.evictIfNeeded();
      this.persistCounters();
    }
  }

  addSSEChunk(messageId: string, chunk: SSEChunk): void {
    const msg = this.messages.get(messageId);
    if (msg && msg.isSSE) {
      msg.sseChunks.push(chunk);
      // Collect parts in array to avoid O(n²) string concatenation
      if (!msg._responseBodyParts) {
        msg._responseBodyParts = [];
      }
      msg._responseBodyParts.push(chunk.data);
    }
  }

  /** Get the full responseBody, flushing buffered parts if needed */
  getResponseBody(messageId: string): string {
    const msg = this.messages.get(messageId);
    if (!msg) return '';
    flushResponseBodyParts(msg);
    return msg.responseBody;
  }

  getAllMessages(): ProxyMessage[] {
    // Flush all pending body parts for in-memory messages
    for (const msg of this.messages.values()) {
      flushResponseBodyParts(msg);
    }

    const excludeIds = Array.from(this.messages.keys());
    const db = this.ensureDb();
    const dbMsgs = db.getAllMessagesExcluding(excludeIds);
    // Merge: DB messages + in-memory messages, sorted by seq
    const all = [...dbMsgs, ...Array.from(this.messages.values())];
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  /** Iterable iterator that yields messages one-by-one with lazy flush,
   *  avoiding a single synchronous flush of the entire dataset. */
  *getAllMessagesIterator(): IterableIterator<ProxyMessage> {
    const excludeIds = Array.from(this.messages.keys());
    const db = this.ensureDb();
    const dbIter = db.getAllMessagesIteratorExcluding(excludeIds);

    // Yield DB messages first (sorted by seq)
    for (const msg of dbIter) {
      yield msg;
    }
    // Then yield in-memory messages
    for (const msg of this.messages.values()) {
      flushResponseBodyParts(msg);
      yield msg;
    }
  }

  getMessagesSummary(): MessageSummary[] {
    const memSummaries = Array.from(this.messages.values(), toSummary);
    const excludeIds = Array.from(this.messages.keys());
    const db = this.ensureDb();
    const dbSummaries = db.getSummariesExcluding(excludeIds);
    const all = [...dbSummaries, ...memSummaries];
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  getMessagesSummaryAfter(timestamp: number): MessageSummary[] {
    const memSummaries = Array.from(this.messages.values())
      .filter(m => m.timestamp > timestamp || m.updatedAt > timestamp)
      .map(toSummary);
    const excludeIds = Array.from(this.messages.keys());
    const db = this.ensureDb();
    const dbSummaries = db.getSummariesAfterExcluding(timestamp, excludeIds);
    const all = [...dbSummaries, ...memSummaries];
    all.sort((a, b) => a.seq - b.seq);
    return all;
  }

  getMessagesAfter(timestamp: number): ProxyMessage[] {
    return this.getAllMessages().filter(m => m.timestamp > timestamp || m.updatedAt > timestamp);
  }

  getMessage(id: string): ProxyMessage | undefined {
    // Check memory first
    const msg = this.messages.get(id);
    if (msg) {
      flushResponseBodyParts(msg);
      return msg;
    }
    // Fall through to SQLite
    const db = this.ensureDb();
    return db.getMessage(id);
  }

  getStats(): Stats {
    return {
      totalMessages: this.messages.size + this.dbOnlyTotalCount,
      sseMessages: this.memSseCount + this.dbOnlySseCount,
      errorMessages: this.memErrorCount + this.dbOnlyErrorCount,
    };
  }

  clear(): void {
    this.messages.clear();
    this.seqCounter = 0;
    this.memSseCount = 0;
    this.memErrorCount = 0;
    this.dbOnlyTotalCount = 0;
    this.dbOnlySseCount = 0;
    this.dbOnlyErrorCount = 0;
    const db = this.ensureDb();
    db.clear();
    this.persistCounters();
  }

  /** Evict oldest completed messages from memory if over the limit.
   *  Evicted messages become DB-only, so increment db-only counters. */
  private evictIfNeeded(): void {
    const completed: Array<[string, ProxyMessage]> = [];
    for (const entry of this.messages.entries()) {
      if (entry[1].duration > 0) {
        completed.push(entry);
      }
    }

    // Sort by seq ascending — oldest first
    completed.sort((a, b) => a[1].seq - b[1].seq);

    while (completed.length > this.inMemoryLimit) {
      const [id, msg] = completed.shift()!;
      // Adjust memory counters
      if (msg.isSSE) this.memSseCount--;
      if (msg.responseStatus >= 400) this.memErrorCount--;
      // Message becomes DB-only, so increment db-only counters
      this.dbOnlyTotalCount++;
      if (msg.isSSE) this.dbOnlySseCount++;
      if (msg.responseStatus >= 400) this.dbOnlyErrorCount++;
      this.messages.delete(id);
    }
  }

  /** Persist counters to the metadata table.
   *  Metadata stores "total in DB" = dbOnly + (completed messages still in memory).
   *  In-progress messages (duration === 0) are NOT in DB, so don't count them. */
  private persistCounters(): void {
    // Count completed messages still in memory (they're in DB too)
    let completedInMemory = 0;
    let completedSseInMemory = 0;
    let completedErrorInMemory = 0;
    for (const msg of this.messages.values()) {
      if (msg.duration > 0) {
        completedInMemory++;
        if (msg.isSSE) completedSseInMemory++;
        if (msg.responseStatus >= 400) completedErrorInMemory++;
      }
    }

    const db = this.ensureDb();
    db.persistCounters(
      this.dbOnlyTotalCount + completedInMemory,
      this.dbOnlySseCount + completedSseInMemory,
      this.dbOnlyErrorCount + completedErrorInMemory,
      this.seqCounter
    );
  }
}

export const messageStore = new MessageStore();
