import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { messageStore } from './store';
import type { ProxyMessage, ProxyConfig } from './types';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';

function createProxyServer(config: ProxyConfig): express.Application {
  const { targetUrl, enableForwardProxy, upstreamProxy } = config;

  let upstreamProxyUrl: URL | null = null;
  if (upstreamProxy) {
    try {
      upstreamProxyUrl = new URL(upstreamProxy);
    } catch {
      console.error(`[Proxy] Invalid upstream proxy URL: ${upstreamProxy}`);
    }
  }

  const app = express();

  // Forward proxy handler — must be before express.raw() to avoid consuming body
  app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!enableForwardProxy) {
      return next();
    }

    // Detect forward proxy request: absolute URL (http:// or https://)
    const requestUrl = req.originalUrl || req.url;
    if (requestUrl.startsWith('http://') || requestUrl.startsWith('https://')) {
      req.url = requestUrl;
      return handleForwardHttpProxy(req, res, upstreamProxyUrl);
    }

    next();
  });

  // Parse body as raw buffer for transparent forwarding
  app.use(express.raw({ type: '*/*', limit: '50mb' }));

  const proxyMiddleware = createProxyMiddleware({
    target: targetUrl,
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
          url: `${targetUrl}${expressReq.originalUrl}`,
          path: expressReq.originalUrl,
          requestHeaders,
          requestBody,
          responseStatus: proxyRes.statusCode || 0,
          responseHeaders,
          responseBody: '',
          isSSE,
          sseChunks: [],
          duration: 0,
          proxyMode: 'reverse',
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

function handleForwardHttpProxy(req: express.Request, res: express.Response, upstreamProxyUrl: URL | null): void {
  const startTime = Date.now();
  const parsedUrl = new URL(req.url);
  const isHttps = parsedUrl.protocol === 'https:';
  const targetPort = parseInt(parsedUrl.port, 10) || (isHttps ? 443 : 80);

  // Capture request headers
  const requestHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      requestHeaders[key] = value;
    } else if (Array.isArray(value)) {
      requestHeaders[key] = value.join(', ');
    }
  }

  // Collect request body chunks
  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  req.on('end', () => {
    const requestBody = Buffer.concat(bodyChunks);

    let proxyReqOptions: http.RequestOptions;
    if (upstreamProxyUrl) {
      // Route through upstream proxy: send absolute URL as path
      proxyReqOptions = {
        hostname: upstreamProxyUrl.hostname,
        port: parseInt(upstreamProxyUrl.port, 10) || 80,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: `${parsedUrl.hostname}:${targetPort}`,
        },
      };
    } else {
      // Direct connection to target
      proxyReqOptions = {
        hostname: parsedUrl.hostname,
        port: targetPort,
        path: parsedUrl.pathname + parsedUrl.search,
        method: req.method,
        headers: {
          ...req.headers,
          host: `${parsedUrl.hostname}:${targetPort}`,
        },
      };
    }

    // Remove proxy-specific headers
    const headers = { ...proxyReqOptions.headers } as Record<string, string | string[] | undefined>;
    delete headers['proxy-connection'];
    proxyReqOptions.headers = headers;

    const proxyReq = http.request(proxyReqOptions, (proxyRes) => {
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
        method: req.method || 'GET',
        url: req.url,
        path: parsedUrl.pathname + parsedUrl.search,
        requestHeaders,
        requestBody: requestBody.toString('utf-8'),
        responseStatus: proxyRes.statusCode || 0,
        responseHeaders,
        responseBody: '',
        isSSE: /text\/event-stream/i.test(proxyRes.headers['content-type'] || ''),
        sseChunks: [],
        duration: 0,
        proxyMode: 'forward-http',
      });

      const isSSE = /text\/event-stream/i.test(proxyRes.headers['content-type'] || '');

      if (isSSE) {
        // SSE streaming
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        let buffer = '';

        proxyRes.on('data', (chunk: Buffer) => {
          const data = chunk.toString('utf-8');
          buffer += data;
          res.write(chunk);

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

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
        // Regular response
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          messageStore.updateMessage(msg.id, {
            responseBody: body,
            duration: Date.now() - startTime,
          });

          res.writeHead(proxyRes.statusCode!, proxyRes.headers);
          res.end(body);
        });
      }
    });

    proxyReq.on('error', (err) => {
      console.error(`[ForwardProxy] Error forwarding to ${req.url}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
      }
      res.end(`Bad Gateway: ${err.message}`);

      messageStore.createMessage({
        method: req.method || 'GET',
        url: req.url,
        path: parsedUrl.pathname + parsedUrl.search,
        requestHeaders,
        requestBody: requestBody.toString('utf-8'),
        responseStatus: 502,
        responseHeaders: {},
        responseBody: `Bad Gateway: ${err.message}`,
        isSSE: false,
        sseChunks: [],
        duration: Date.now() - startTime,
        proxyMode: 'forward-http',
      });
    });

    // Forward request body
    if (requestBody.length > 0) {
      proxyReq.write(requestBody);
    }
    proxyReq.end();
  });
}

function setupConnectHandler(server: http.Server, config: ProxyConfig): void {
  const { enableForwardProxy, upstreamProxy } = config;

  let upstreamProxyUrl: URL | null = null;
  if (upstreamProxy) {
    try {
      upstreamProxyUrl = new URL(upstreamProxy);
    } catch {
      // Already warned in createProxyServer
    }
  }

  server.on('connect', (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    if (!enableForwardProxy) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    const startTime = Date.now();
    const [hostname, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr, 10) || 443;

    // Capture request headers
    const requestHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') {
        requestHeaders[key] = value;
      } else if (Array.isArray(value)) {
        requestHeaders[key] = value.join(', ');
      }
    }

    if (upstreamProxyUrl) {
      // CONNECT through upstream proxy
      const proxyPort = parseInt(upstreamProxyUrl.port, 10) || 80;
      const proxySocket = net.createConnection({ host: upstreamProxyUrl.hostname, port: proxyPort }, () => {
        // Send CONNECT request to upstream proxy
        proxySocket.write(`CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n\r\n`);
      });

      let connectResponse = '';
      proxySocket.on('data', (chunk: Buffer) => {
        connectResponse += chunk.toString('utf-8');
        // Check if we've received the full HTTP response header
        const headerEnd = connectResponse.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        const statusLine = connectResponse.substring(0, connectResponse.indexOf('\r\n'));
        const statusCode = parseInt(statusLine.split(' ')[1], 10);

        if (statusCode === 200) {
          // Tunnel established through upstream proxy
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          // Forward any remaining data after the header
          const remaining = connectResponse.substring(headerEnd + 4);
          if (remaining.length > 0) {
            clientSocket.write(remaining);
          }
          if (head.length > 0) {
            proxySocket.write(head);
          }

          messageStore.createMessage({
            method: 'CONNECT',
            url: req.url || '',
            path: req.url || '',
            requestHeaders,
            requestBody: '',
            responseStatus: 200,
            responseHeaders: {},
            responseBody: '',
            isSSE: false,
            sseChunks: [],
            duration: Date.now() - startTime,
            proxyMode: 'forward-connect',
          });

          // Bidirectional pipe through upstream proxy
          proxySocket.pipe(clientSocket);
          clientSocket.pipe(proxySocket);
        } else {
          // Upstream proxy refused the CONNECT
          clientSocket.end(connectResponse);
          proxySocket.end();

          messageStore.createMessage({
            method: 'CONNECT',
            url: req.url || '',
            path: req.url || '',
            requestHeaders,
            requestBody: '',
            responseStatus: statusCode || 502,
            responseHeaders: {},
            responseBody: `Upstream proxy returned: ${statusLine}`,
            isSSE: false,
            sseChunks: [],
            duration: Date.now() - startTime,
            proxyMode: 'forward-connect',
          });
        }

        // Remove this data listener — subsequent data should be piped raw
        proxySocket.removeAllListeners('data');
      });

      proxySocket.on('error', (err) => {
        console.error(`[ForwardProxy] Upstream proxy CONNECT error for ${req.url}: ${err.message}`);
        clientSocket.end();

        messageStore.createMessage({
          method: 'CONNECT',
          url: req.url || '',
          path: req.url || '',
          requestHeaders,
          requestBody: '',
          responseStatus: 502,
          responseHeaders: {},
          responseBody: `Upstream proxy error: ${err.message}`,
          isSSE: false,
          sseChunks: [],
          duration: Date.now() - startTime,
          proxyMode: 'forward-connect',
        });
      });

      clientSocket.on('error', (err) => {
        console.error(`[ForwardProxy] Client socket error for CONNECT ${req.url}: ${err.message}`);
        proxySocket.end();
      });
    } else {
      // Direct CONNECT tunnel (no upstream proxy)
      const targetSocket = net.createConnection({ host: hostname, port }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) {
          targetSocket.write(head);
        }

        messageStore.createMessage({
          method: 'CONNECT',
          url: req.url || '',
          path: req.url || '',
          requestHeaders,
          requestBody: '',
          responseStatus: 200,
          responseHeaders: {},
          responseBody: '',
          isSSE: false,
          sseChunks: [],
          duration: Date.now() - startTime,
          proxyMode: 'forward-connect',
        });

        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);
      });

      targetSocket.on('error', (err) => {
        console.error(`[ForwardProxy] CONNECT tunnel error for ${req.url}: ${err.message}`);
        clientSocket.end();

        messageStore.createMessage({
          method: 'CONNECT',
          url: req.url || '',
          path: req.url || '',
          requestHeaders,
          requestBody: '',
          responseStatus: 502,
          responseHeaders: {},
          responseBody: `Tunnel error: ${err.message}`,
          isSSE: false,
          sseChunks: [],
          duration: Date.now() - startTime,
          proxyMode: 'forward-connect',
        });
      });

      clientSocket.on('error', (err) => {
        console.error(`[ForwardProxy] Client socket error for CONNECT ${req.url}: ${err.message}`);
        targetSocket.end();
      });
    }
  });
}

function createWebServer(config: ProxyConfig): express.Application {
  const app = express();
  app.use(express.json());

  // Serve static files - resolve relative to compiled dist/ directory
  const publicDir = path.resolve(__dirname, '..', 'src', 'public');
  app.use(express.static(publicDir));

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

  // Get stats + current config
  app.get('/api/stats', (_req, res) => {
    res.json({
      ...messageStore.getStats(),
      proxyMode: config.enableForwardProxy ? 'forward' : 'reverse',
      targetUrl: config.targetUrl,
      upstreamProxy: config.upstreamProxy,
    });
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

export { createProxyServer, createWebServer, setupConnectHandler };
