import { ProxyMessage, SSEChunk, Stats } from './types';
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
  const line = JSON.stringify(msg) + '\n';
  fs.appendFile(logPath, line, (err) => {
    if (err) {
      console.error(`[Log] Failed to write log file: ${err.message}`);
    }
  });
}

class MessageStore {
  private messages: Map<string, ProxyMessage> = new Map();
  private seqCounter: number = 0;

  createMessage(partial: Omit<ProxyMessage, 'id' | 'timestamp' | 'seq' | 'updatedAt'>): ProxyMessage {
    const now = Date.now();
    const msg: ProxyMessage = {
      ...partial,
      id: uuidv4(),
      seq: ++this.seqCounter,
      timestamp: now,
      updatedAt: now,
    };
    this.messages.set(msg.id, msg);
    return msg;
  }

  updateMessage(id: string, updates: Partial<ProxyMessage>): void {
    const msg = this.messages.get(id);
    if (msg) {
      Object.assign(msg, updates, { updatedAt: Date.now() });
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
      // Append to responseBody for convenience
      if (msg.responseBody && !msg.responseBody.endsWith('\n')) {
        msg.responseBody += '\n';
      }
      msg.responseBody += chunk.data;
    }
  }

  getAllMessages(): ProxyMessage[] {
    return Array.from(this.messages.values());
  }

  getMessagesAfter(timestamp: number): ProxyMessage[] {
    return this.getAllMessages().filter(m => m.timestamp > timestamp || m.updatedAt > timestamp);
  }

  getMessage(id: string): ProxyMessage | undefined {
    return this.messages.get(id);
  }

  getStats(): Stats {
    const msgs = this.getAllMessages();
    return {
      totalMessages: msgs.length,
      sseMessages: msgs.filter(m => m.isSSE).length,
      errorMessages: msgs.filter(m => m.responseStatus >= 400).length,
    };
  }

  clear(): void {
    this.messages.clear();
    this.seqCounter = 0;
  }
}

export const messageStore = new MessageStore();
