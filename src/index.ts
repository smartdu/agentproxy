import { createProxyServer, createWebServer, PROXY_PORT, WEB_PORT, TARGET_URL } from './server';

const proxyApp = createProxyServer();
const webApp = createWebServer();

proxyApp.listen(PROXY_PORT, () => {
  console.log(`[Proxy] HTTP proxy listening on port ${PROXY_PORT} -> ${TARGET_URL}`);
});

webApp.listen(WEB_PORT, () => {
  console.log(`[Web] Web UI and API listening on port ${WEB_PORT}`);
  console.log(`[Web] Open http://localhost:${WEB_PORT} to view messages`);
});
