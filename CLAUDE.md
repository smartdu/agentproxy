# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- **Development**: `npm run dev` – starts the proxy and web server in development mode using ts-node-dev (auto‑restart on file changes).
- **Build**: `npm run build` – compiles TypeScript to JavaScript in the `dist/` directory.
- **Production**: `npm start` – runs the compiled proxy server (requires `dist/` built first).
- **Test**: `npm test` – runs the compatibility test suite (requires `TARGET_URL` and `API_KEY` environment variables).
- **Publish**: `npm publish` – publishes the package (runs `prepublishOnly` script which calls `npm run build`).

**CLI Usage** (after building or installing globally):
- `agentproxy` – start with default settings
- `agentproxy -t http://target:port` – specify target URL
- `agentproxy -p 3001 -w 8081` – custom proxy and web ports
- `agentproxy -f` – enable forward proxy (HTTP + CONNECT tunnel)
- `agentproxy -f -u http://proxy:8080` – forward proxy with upstream proxy
- `agentproxy -h` – show help
- `agentproxy -v` – show version

**Environment variables** (fallback when CLI args not provided):
- `TARGET_URL` – the upstream HTTPS API to proxy to (default: `https://api.deepseek.com`).
- `PROXY_PORT` – port the proxy listens on (default: `3000`).
- `WEB_PORT` – port the web UI listens on (default: `8080`).
- `API_KEY` – required for running tests (your DeepSeek/OpenAI/Anthropic API key).
- `LOG_DIR` – directory for daily log files (default: `logs`). Messages are automatically appended to `logs/YYYY-MM-DD.log` when they complete.
- `ENABLE_FORWARD_PROXY` – enable forward proxy mode (default: `false`).
- `UPSTREAM_PROXY` – upstream proxy URL for forward proxy mode (default: `http://10.30.6.49:9090`).

## Usage Examples

### Starting the proxy
```bash
TARGET_URL=https://api.deepseek.com npm run dev
```
Proxy listens on `http://localhost:3000`, Web UI on `http://localhost:8080`.

### Sending requests via curl
```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

### Using OpenAI SDK (Python)
```python
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",
    base_url="http://localhost:3000/v1"  # point to the proxy
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### Viewing the Web UI
Open `http://localhost:8080` in your browser. The UI shows:
- **Top bar**: total messages, SSE messages, errors, auto‑refresh interval, live/offline mode switch.
- **Left sidebar**: message list with sequence, HTTP method, path, status code, duration, export/import buttons.
- **Right panel**: request/response details (headers, body), SSE chunks displayed in real‑time.

**UI Features:**
- **Export/Import**: Export all messages as JSON file; import previously exported JSON to browse offline.
- **Live/Offline mode**: Switch between real‑time connection to proxy server and offline browsing of imported data.
- **Log persistence**: Each completed request is appended to a daily log file under `LOG_DIR` (default `logs/`).

## REST API

The web server provides these endpoints:
- `GET /api/messages` – all captured messages.
- `GET /api/messages/latest?after=<timestamp>` – incremental updates (used by UI’s Server‑Sent Events).
- `GET /api/messages/:id` – single message details.
- `GET /api/stats` – total, SSE, and error counts.
- `DELETE /api/messages` – clear all stored messages.

## Architecture

The project is an HTTPS reverse proxy with real‑time web monitoring, designed for OpenAI/Anthropic‑compatible LLM APIs. It consists of two separate Express servers that can operate in multiple proxy modes:

### Proxy Modes
1. **Reverse Proxy** (default): Forwards HTTP requests to a specified HTTPS target (e.g., `http://localhost:3000` → `https://api.deepseek.com`)
2. **Forward Proxy** (HTTP): Handles absolute URL requests (e.g., `GET http://example.com/`) with optional upstream proxy chaining
3. **Forward Proxy** (CONNECT tunnel): Establishes TLS tunnels for HTTPS traffic through forward proxy

### Core Components

1. **Proxy server** (`src/server.ts` `createProxyServer()`)
   - Listens on `PROXY_PORT` (default 3000).
   - Uses `http-proxy-middleware` with `selfHandleResponse: true` to intercept and capture responses.
   - Parses request body as raw buffer (`express.raw`) up to 50 MB, preserving binary data.
   - Captures request headers, body, response headers, status, and body (or SSE chunks) in a memory store (`src/store.ts`).
   - Handles SSE (Server‑Sent Events) streams specially: each chunk is stored individually and displayed in the web UI as it arrives.
   - Augments the Express `Request` type with `_proxyStartTime` and `_messageId` for timing and correlation.
   - **Forward proxy detection**: Checks for absolute URLs (`http://` or `https://`) to switch to forward proxy mode.

2. **Web server** (`src/server.ts` `createWebServer()`)
   - Listens on `WEB_PORT` (default 8080).
   - Serves static files from `src/public/` (the monitoring UI).
   - Provides the REST API described above.

3. **Memory store** (`src/store.ts`)
   - Singleton `MessageStore` class that holds `ProxyMessage` objects in a `Map`.
   - Each message gets a UUID, a sequential `seq` number, and a timestamp.
   - SSE chunks are appended to `message.sseChunks` and also concatenated into `message.responseBody` for convenience.
   - **Log persistence**: When a message completes (duration set), it is appended as a JSON line to a daily log file under `logs/YYYY-MM-DD.log` (configurable via `LOG_DIR`).
   - **Performance optimization**: Uses `_responseBodyParts` array for incremental SSE chunk collection to avoid O(n²) string concatenation.

4. **Entry point** (`src/index.ts`)
   - CLI interface with argument parsing using `node:util.parseArgs`.
   - Starts both servers and logs their listening addresses.
   - Also serves as the CLI binary (`agentproxy`) after compilation. You can install globally (`npm install -g .`) and run `agentproxy` directly.

5. **Web UI** (`src/public/index.html`)
   - Three‑panel layout: header with stats and controls, left sidebar with message list, right panel with request/response details.
   - Uses Server‑Sent Events to receive real‑time updates from the web server’s `/api/messages/latest` endpoint.
   - Shows SSE responses chunk‑by‑chunk as they arrive.
   - Provides export/import buttons to save/load message data as JSON files.
   - Supports live/offline mode switching: live mode polls the proxy server; offline mode works with imported data.

## TypeScript

- The code is written in TypeScript with strict mode enabled.
- Compiled output goes to `dist/` (CommonJS, ES2020 target).
- Type definitions are emitted (`dist/*.d.ts`).
- No linting or formatting tools are currently configured.

## Testing

The test suite (`src/test.ts`) verifies OpenAI‑API compatibility by sending requests through the proxy to a real upstream (DeepSeek by default). It exercises:
- Non‑streaming chat completions.
- Streaming (SSE) chat completions.
- Model listing.
- Web API message recording.

Run with:
```bash
TARGET_URL=https://api.deepseek.com API_KEY=your‑key npm test
```

The test expects both the proxy and web server to be running (started by `npm run dev` or separately).

**Note:** The test uses DeepSeek API by default, but you can target any OpenAI‑compatible API by setting `TARGET_URL` (e.g., `https://api.openai.com`).

**Debugging tests**: Since tests run via `ts-node-dev`, you can modify `src/test.ts` and the test will automatically restart. For single test runs, you can edit the test file to focus on specific test cases.

## CLI Usage

After building (`npm run build`) you can install the package globally:
```bash
npm install -g .
```
Then run the proxy directly:
```bash
agentproxy
```
Environment variables (`TARGET_URL`, `PROXY_PORT`, `WEB_PORT`, `LOG_DIR`) work the same as with `npm start`.

**Package name:** `@smartdu/agentproxy` – you can also install globally via `npm install -g @smartdu/agentproxy`.

## Notes

- The proxy only forwards HTTP to HTTPS; it does not terminate TLS itself.
- Request/response bodies are stored as UTF‑8 strings (max 50 MB per request).
- All state is in memory and lost when the process exits; however, each request is persisted to a daily log file for later inspection.
- The proxy is designed for development and debugging of LLM API calls, not for production load.
- The Web UI is in Chinese but fully functional; labels are self‑explanatory.
- **Forward proxy mode**: When enabled, the proxy can handle both reverse proxy requests (to `TARGET_URL`) and forward proxy requests (absolute URLs). This is useful for debugging applications that use HTTP proxies.
- **SSE optimization**: SSE responses are collected incrementally using an internal `_responseBodyParts` array to avoid O(n²) string concatenation overhead when processing large streams.