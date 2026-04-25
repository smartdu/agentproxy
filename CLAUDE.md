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
- `agentproxy -d /path/to/proxy.db` – custom SQLite database path
- `agentproxy -f` – enable forward proxy (HTTP + CONNECT tunnel)
- `agentproxy -f -u http://proxy:8080` – forward proxy with upstream proxy
- `agentproxy -h` – show help
- `agentproxy -v` – show version

**Environment variables** (fallback when CLI args not provided):
- `TARGET_URL` – the upstream HTTPS API to proxy to (default: `https://api.deepseek.com`).
- `PROXY_PORT` – port the proxy listens on (default: `3000`).
- `WEB_PORT` – port the web UI listens on (default: `8080`).
- `API_KEY` – required for running tests (your DeepSeek/OpenAI/Anthropic API key).
- `DB_PATH` – path to the SQLite database file (default: `data/agentproxy.db`).
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
- **Export**: Export all messages as JSON file.
- **Import**: Import previously exported JSON files or SQLite `.db` database files to browse offline. Import is client-side only and does not modify the server database.
- **Live/Offline mode**: Switch between real‑time connection to proxy server and offline browsing of imported data.
- **Data persistence**: All completed messages are persisted to a SQLite database. Data survives process restarts.

## REST API

The web server provides these endpoints:
- `GET /api/messages` – all captured messages (summaries only, no body/chunks).
- `GET /api/messages/latest?after=<timestamp>` – incremental updates (used by UI polling).
- `GET /api/messages/export` – streaming export of all messages with full data (bodies, SSE chunks).
- `GET /api/messages/:id` – single message details (full data including body and SSE chunks).
- `GET /api/stats` – total, SSE, and error counts.
- `DELETE /api/messages` – clear all stored messages (both memory and SQLite).

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
   - Captures request headers, body, response headers, status, and body (or SSE chunks) in a hybrid store (`src/store.ts`).
   - Handles SSE (Server‑Sent Events) streams specially: each chunk is stored individually and displayed in the web UI as it arrives.
   - Augments the Express `Request` type with `_proxyStartTime` and `_messageId` for timing and correlation.
   - **Forward proxy detection**: Checks for absolute URLs (`http://` or `https://`) to switch to forward proxy mode.

2. **Web server** (`src/server.ts` `createWebServer()`)
   - Listens on `WEB_PORT` (default 8080).
   - Serves static files from `src/public/` (the monitoring UI, plus sql.js WASM for SQLite import).
   - Provides the REST API described above.

3. **Hybrid message store** (`src/store.ts` + `src/database.ts`)
   - Singleton `MessageStore` class using a hybrid memory/SQLite architecture:
     - **Hot layer**: In-memory `Map<string, ProxyMessage>` holds in-progress messages (duration === 0) and the most recent N completed messages (configurable via `inMemoryLimit`, default 100).
     - **Cold layer**: SQLite database (`better-sqlite3`) stores all completed messages permanently.
   - **Data flow**: Messages are created in memory. When a message completes (duration set), it is persisted to SQLite in a single transaction (message row + SSE chunks). If the in-memory completed count exceeds the limit, the oldest completed message is evicted from memory.
   - **Query merging**: Read operations check memory first, then fall back to SQLite. `getMessagesSummary()` and similar methods merge results from both layers, deduplicating via `NOT IN` exclusion.
   - **Counter model**: Stats counters are maintained as pairs — memory-only and DB-only — and summed in `getStats()` without DB queries. Counters are persisted to the `metadata` table on every completion and on shutdown.
   - **Warm cache**: On startup, the most recent N completed messages are loaded from SQLite back into memory so the UI immediately shows recent history.
   - **Shutdown**: `init(dbPath)` must be called before first use; `close()` must be called on SIGINT/SIGTERM to persist counters and checkpoint the WAL.
   - Each message gets a UUID, a sequential `seq` number, and a timestamp.
   - SSE chunks are appended to `message.sseChunks` in memory and bulk-inserted to SQLite when the stream completes.
   - **Performance optimization**: Uses `_responseBodyParts` array for incremental SSE chunk collection to avoid O(n²) string concatenation. This field is never persisted — it is flushed into `responseBody` before DB write.

4. **Database layer** (`src/database.ts`)
   - `MessageDatabase` class wrapping `better-sqlite3`.
   - SQLite configuration: WAL mode, `synchronous=NORMAL`, foreign keys ON, busy timeout 5s, 64MB page cache.
   - Three tables: `messages` (core message data with JSON-encoded headers), `sse_chunks` (separate table with ordinal position), `metadata` (key-value store for counters).
   - All writes use prepared statements and transactions (message + chunks inserted atomically).
   - Read operations support `excludeIds` parameter to avoid duplicates when merging with in-memory data.

5. **Entry point** (`src/index.ts`)
   - CLI interface with argument parsing using `node:util.parseArgs`.
   - Initializes the message store with the SQLite database path (`messageStore.init(dbPath)`).
   - Registers SIGINT/SIGTERM shutdown hooks to call `messageStore.close()`.
   - Starts both servers and logs their listening addresses.
   - Also serves as the CLI binary (`agentproxy`) after compilation. You can install globally (`npm install -g .`) and run `agentproxy` directly.

6. **Web UI** (`src/public/index.html`)
   - Three‑panel layout: header with stats and controls, left sidebar with message list, right panel with request/response details.
   - Polls `/api/messages/latest` at a configurable interval (default 3s) to get incremental updates.
   - Shows SSE responses chunk‑by‑chunk as they arrive.
   - Provides export (JSON) and import (JSON or SQLite `.db`) buttons. SQLite import uses `sql.js` (WASM) loaded lazily on first use — parsing happens entirely in the browser.
   - Supports live/offline mode switching: live mode polls the proxy server; offline mode works with imported data.
   - **Detail cache invalidation**: When polling detects a message completing (duration 0 → >0) or `updatedAt` changing, the cached detail is invalidated and the detail panel is auto-refreshed.

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
Environment variables (`TARGET_URL`, `PROXY_PORT`, `WEB_PORT`, `DB_PATH`) work the same as with `npm start`.

**Package name:** `@smartdu/agentproxy` – you can also install globally via `npm install -g @smartdu/agentproxy`.

## Notes

- The proxy only forwards HTTP to HTTPS; it does not terminate TLS itself.
- Request/response bodies are stored as UTF‑8 strings (max 50 MB per request).
- Messages are persisted to a SQLite database and survive process restarts. The database is located at `data/agentproxy.db` by default (configurable via `--db` or `DB_PATH`).
- The proxy is designed for development and debugging of LLM API calls, not for production load.
- The Web UI is in Chinese but fully functional; labels are self‑explanatory.
- **Forward proxy mode**: When enabled, the proxy can handle both reverse proxy requests (to `TARGET_URL`) and forward proxy requests (absolute URLs). This is useful for debugging applications that use HTTP proxies.
- **SSE optimization**: SSE responses are collected incrementally using an internal `_responseBodyParts` array to avoid O(n²) string concatenation overhead when processing large streams. This array is never persisted — it is flushed into `responseBody` before writing to SQLite.
- **SQLite import**: The Web UI can import `.db` files from other AgentProxy instances using `sql.js` (SQLite compiled to WebAssembly). The WASM engine is loaded lazily — only downloaded when a `.db` file is first imported. Import is client-side only and does not modify the server's database.
