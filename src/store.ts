import { ProxyMessage, SSEChunk, Stats } from './types';
import { v4 as uuidv4 } from 'uuid';

class MessageStore {
  private messages: Map<string, ProxyMessage> = new Map();
  private seqCounter: number = 0;

  createMessage(partial: Omit<ProxyMessage, 'id' | 'timestamp' | 'seq'>): ProxyMessage {
    const msg: ProxyMessage = {
      ...partial,
      id: uuidv4(),
      seq: ++this.seqCounter,
      timestamp: Date.now(),
    };
    this.messages.set(msg.id, msg);
    return msg;
  }

  updateMessage(id: string, updates: Partial<ProxyMessage>): void {
    const msg = this.messages.get(id);
    if (msg) {
      Object.assign(msg, updates);
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
    return this.getAllMessages().filter(m => m.timestamp > timestamp);
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
