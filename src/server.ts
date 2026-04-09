import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { messageStore } from './store';
import type { ProxyMessage } from './types';

const TARGET_URL = process.env.TARGET_URL || 'https://api.openai.com';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
const WEB_PORT = parseInt(process.env.WEB_PORT || '8080', 10);

function createProxyServer(): express.Application {
  const app = express();

  // Parse body as raw buffer for transparent forwarding
  app.use(express.raw({ type: '*/*', limit: '50mb' }));

  const proxyMiddleware = createProxyMiddleware({
    target: TARGET_URL,
    changeOrigin: true,
    secure: true,
    selfHandleResponse: true, // We need to capture the response

    on: {
      proxyReq: (proxyReq, req, _res) => {
        // Forward the raw body
        const body = (req as express.Request).body;
        if (body && Buffer.isBuffer(body) && body.length > 0) {
          proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
          proxyReq.write(body);
        }
      },

      proxyRes: (proxyRes, req, _res) => {
        const expressReq = req as express.Request;
        const startTime = expressReq._proxyStartTime || Date.now();
        const isSSE = /text\/event-stream/i.test(proxyRes.headers['content-type'] || '');

        // Capture request headers
        const requestHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(expressReq.headers)) {
          if (typeof value === 'string') {
            requestHeaders[key] = value;
          } else if (Array.isArray(value)) {
            requestHeaders[key] = value.join(', ');
          }
        }

        // Capture request body
        let requestBody = '';
        if (expressReq.body && Buffer.isBuffer(expressReq.body)) {
          requestBody = expressReq.body.toString('utf-8');
        }

        // Capture response headers
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(proxyRes.headers)) {
          if (typeof value === 'string') {
            responseHeaders[key] = value;
          } else if (Array.isArray(value)) {
            responseHeaders[key] = value.join(', ');
          }
        }

        const msg = messageStore.createMessage({
          method: expressReq.method,
          url: `${TARGET_URL}${expressReq.originalUrl}`,
          path: expressReq.originalUrl,
          requestHeaders,
          requestBody,
          responseStatus: proxyRes.statusCode || 0,
          responseHeaders,
          responseBody: '',
          isSSE,
          sseChunks: [],
          duration: 0,
        });

        expressReq._messageId = msg.id;

        if (isSSE) {
          // Handle SSE streaming
          const res = _res as express.Response;
          res.writeHead(proxyRes.statusCode!, proxyRes.headers);

          let buffer = '';
          proxyRes.on('data', (chunk: Buffer) => {
            const data = chunk.toString('utf-8');
            buffer += data;
            res.write(chunk);

            // Process complete SSE events
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep incomplete line in buffer

            if (lines.length > 0) {
              const eventData = lines.join('\n') + '\n';
              messageStore.addSSEChunk(msg.id, {
                timestamp: Date.now(),
                data: eventData,
              });
            }
          });

          proxyRes.on('end', () => {
            if (buffer) {
              messageStore.addSSEChunk(msg.id, {
                timestamp: Date.now(),
                data: buffer + '\n',
              });
            }
            messageStore.updateMessage(msg.id, {
              duration: Date.now() - startTime,
            });
            res.end();
          });
        } else {
          // Handle regular response
          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });

          proxyRes.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            messageStore.updateMessage(msg.id, {
              responseBody: body,
              duration: Date.now() - startTime,
            });

            const res = _res as express.Response;
            res.writeHead(proxyRes.statusCode!, proxyRes.headers);
            res.end(body);
          });
        }
      },
    },
  });

  // Attach start time BEFORE proxy middleware
  app.use((req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req._proxyStartTime = Date.now();
    next();
  });

  app.use('/', proxyMiddleware);

  return app;
}

function createWebServer(): express.Application {
  const app = express();
  app.use(express.json());

  // Serve static files
  app.use(express.static('src/public'));

  // Get all messages
  app.get('/api/messages', (_req, res) => {
    const messages = messageStore.getAllMessages();
    res.json(messages);
  });

  // Get latest messages after a given timestamp
  app.get('/api/messages/latest', (req, res) => {
    const after = parseInt(req.query.after as string, 10) || 0;
    const messages = messageStore.getMessagesAfter(after);
    res.json(messages);
  });

  // Get a single message
  app.get('/api/messages/:id', (req, res) => {
    const msg = messageStore.getMessage(req.params.id);
    if (!msg) {
      return res.status(404).json({ error: 'Message not found' });
    }
    res.json(msg);
  });

  // Get stats
  app.get('/api/stats', (_req, res) => {
    res.json(messageStore.getStats());
  });

  // Clear all messages
  app.delete('/api/messages', (_req, res) => {
    messageStore.clear();
    res.json({ ok: true });
  });

  return app;
}

// Augment express Request type
declare global {
  namespace Express {
    interface Request {
      _proxyStartTime?: number;
      _messageId?: string;
    }
  }
}

export { createProxyServer, createWebServer, PROXY_PORT, WEB_PORT, TARGET_URL };
