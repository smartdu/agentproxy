export interface ProxyMessage {
  id: string;
  seq: number;
  timestamp: number;
  updatedAt: number;
  method: string;
  url: string;
  path: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  isSSE: boolean;
  sseChunks: SSEChunk[];
  duration: number;
}

export interface SSEChunk {
  timestamp: number;
  data: string;
}

export interface Stats {
  totalMessages: number;
  sseMessages: number;
  errorMessages: number;
}
