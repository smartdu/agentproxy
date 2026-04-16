import { ProxyMessage, MessageSummary, SSEChunk, Stats } from './types';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

const LOG_DIR = process.env.LOG_DIR || 'logs';

function getLogFilePath(timestamp: number): string {
  const d = new Date(timestamp);
  const filename = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(LOG_DIR, filename);
}

function appendToLogFile(msg: ProxyMessage): void {
  const logPath = getLogFilePath(msg.timestamp);
  const dir = path.dirname(logPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Ensure responseBody is fully assembled before logging
  flushResponseBodyParts(msg);
  const line = JSON.stringify(msg) + '\n';
  fs.appendFile(logPath, line, (err) => {
    if (err) {
      console.error(`[Log] Failed to write log file: ${err.message}`);
    }
  });
}

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

class MessageStore {
  private messages: Map<string, ProxyMessage> = new Map();
  private seqCounter: number = 0;
  // Cached counters to avoid full traversals
  private sseCount: number = 0;
  private errorCount: number = 0;

  createMessage(partial: Omit<ProxyMessage, 'id' | 'timestamp' | 'seq' | 'updatedAt'>): ProxyMessage {
    const now = Date.now();
    const msg: ProxyMessage = {
      ...partial,
      id: uuidv4(),
      seq: ++this.seqCounter,
      timestamp: now,
      updatedAt: now,
    };
    if (msg.isSSE) this.sseCount++;
    if (msg.responseStatus >= 400) this.errorCount++;
    this.messages.set(msg.id, msg);
    return msg;
  }

  updateMessage(id: string, updates: Partial<ProxyMessage>): void {
    const msg = this.messages.get(id);
    if (msg) {
      // Track counter changes before update
      const oldStatus = msg.responseStatus;
      const oldSSE = msg.isSSE;
      Object.assign(msg, updates, { updatedAt: Date.now() });
      // Update counters if relevant fields changed
      if (oldSSE !== msg.isSSE) {
        this.sseCount += msg.isSSE ? 1 : -1;
      }
      if ((oldStatus >= 400) !== (msg.responseStatus >= 400)) {
        this.errorCount += msg.responseStatus >= 400 ? 1 : -1;
      }
      // Write to log file once the message is complete (duration is set)
      if (updates.duration !== undefined && updates.duration > 0) {
        appendToLogFile(msg);
      }
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
    // Flush all pending body parts before returning
    for (const msg of this.messages.values()) {
      flushResponseBodyParts(msg);
    }
    return Array.from(this.messages.values());
  }

  /** Iterable iterator that yields messages one-by-one with lazy flush,
   *  avoiding a single synchronous flush of the entire dataset. */
  *getAllMessagesIterator(): IterableIterator<ProxyMessage> {
    for (const msg of this.messages.values()) {
      flushResponseBodyParts(msg);
      yield msg;
    }
  }

  getMessagesSummary(): MessageSummary[] {
    return Array.from(this.messages.values(), toSummary);
  }

  getMessagesSummaryAfter(timestamp: number): MessageSummary[] {
    const result: MessageSummary[] = [];
    for (const msg of this.messages.values()) {
      if (msg.timestamp > timestamp || msg.updatedAt > timestamp) {
        result.push(toSummary(msg));
      }
    }
    return result;
  }

  getMessagesAfter(timestamp: number): ProxyMessage[] {
    return this.getAllMessages().filter(m => m.timestamp > timestamp || m.updatedAt > timestamp);
  }

  getMessage(id: string): ProxyMessage | undefined {
    const msg = this.messages.get(id);
    if (msg) flushResponseBodyParts(msg);
    return msg;
  }

  getStats(): Stats {
    return {
      totalMessages: this.messages.size,
      sseMessages: this.sseCount,
      errorMessages: this.errorCount,
    };
  }

  clear(): void {
    this.messages.clear();
    this.seqCounter = 0;
    this.sseCount = 0;
    this.errorCount = 0;
  }
}

export const messageStore = new MessageStore();
