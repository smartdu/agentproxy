#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createProxyServer, createWebServer, setupConnectHandler } from './server';
import type { ProxyConfig } from './types';
import * as fs from 'fs';
import * as path from 'path';

const VERSION = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf-8')
).version;

const HELP = `
AgentProxy v${VERSION} - API 代理监控工具

用法:
  agentproxy [选项]

选项:
  -t, --target <url>        目标地址（默认 https://api.deepseek.com）
  -p, --proxy-port <port>   代理端口（默认 3000）
  -w, --web-port <port>     Web UI 端口（默认 8080）
  -f, --forward-proxy       启用正向代理（HTTP + CONNECT 隧道）
  -u, --upstream <url>      上游代理地址（默认 http://10.30.6.49:9090）
  -h, --help                显示帮助信息
  -v, --version             显示版本号

环境变量（作为后备，命令行参数优先）:
  TARGET_URL, PROXY_PORT, WEB_PORT, ENABLE_FORWARD_PROXY, UPSTREAM_PROXY

示例:
  agentproxy                                    # 反向代理到默认目标
  agentproxy -t http://10.30.6.49:9090          # 反向代理到指定目标
  agentproxy -f                                 # 启用正向代理
  agentproxy -f -u http://proxy:8080            # 正向代理经上游代理转发
  agentproxy -f -t http://10.30.6.49:9090       # 同时启用反向代理和正向代理
`;

try {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', short: 't' },
      'proxy-port': { type: 'string', short: 'p' },
      'web-port': { type: 'string', short: 'w' },
      'forward-proxy': { type: 'boolean', short: 'f', default: false },
      upstream: { type: 'string', short: 'u' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (values.version) {
    console.log(`AgentProxy v${VERSION}`);
    process.exit(0);
  }

  // Priority: CLI args > env vars > defaults
  const config: ProxyConfig = {
    targetUrl: values.target || process.env.TARGET_URL || 'https://api.deepseek.com',
    proxyPort: parseInt(values['proxy-port'] || process.env.PROXY_PORT || '3000', 10),
    webPort: parseInt(values['web-port'] || process.env.WEB_PORT || '8080', 10),
    enableForwardProxy: values['forward-proxy'] || process.env.ENABLE_FORWARD_PROXY === 'true',
    upstreamProxy: values.upstream || process.env.UPSTREAM_PROXY || 'http://10.30.6.49:9090',
  };

  const proxyApp = createProxyServer(config);
  const webApp = createWebServer(config);

  const proxyServer = proxyApp.listen(config.proxyPort, () => {
    console.log(`[Proxy] HTTP proxy listening on port ${config.proxyPort} -> ${config.targetUrl}`);
    if (config.enableForwardProxy) {
      console.log(`[Proxy] Forward proxy enabled (HTTP + CONNECT tunnel)`);
      if (config.upstreamProxy) {
        console.log(`[Proxy] Upstream proxy: ${config.upstreamProxy}`);
      }
    }
  });

  // Setup CONNECT tunnel handler for HTTPS forward proxy
  setupConnectHandler(proxyServer, config);

  webApp.listen(config.webPort, () => {
    console.log(`[Web] Web UI and API listening on port ${config.webPort}`);
    console.log(`[Web] Open http://localhost:${config.webPort} to view messages`);
  });
} catch (err: any) {
  if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    console.error(`错误: ${err.message}`);
    console.error('使用 --help 查看帮助信息');
    process.exit(1);
  }
  throw err;
}
