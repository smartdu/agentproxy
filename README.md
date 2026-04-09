# AgentProxy

HTTPS 反向代理，支持请求/响应日志记录和 Web 实时预览，专为 OpenAI / Anthropic 等大模型 API 设计。

## 功能特性

- **HTTP -> HTTPS 反向代理**：客户端通过 HTTP 访问，代理透明转发到 HTTPS 目标服务
- **实时 Web 监控**：三栏布局查看所有请求和响应，支持 SSE 流式响应逐 chunk 展示
- **RESTful API**：支持全量和增量拉取消息，客户端主动轮询
- **一键复制**：请求/响应 Body 支持 Copy 按钮
- **兼容 OpenAI API / Anthropic API** 等主流大模型接口

## 快速开始

### 通过 npm 安装（推荐）

```bash
# 全局安装
npm install -g @smartdu/agentproxy

# 直接运行
TARGET_URL=https://api.deepseek.com agentproxy
```

或使用 npx 免安装运行：

```bash
npx @smartdu/agentproxy
```

### 从源码运行

```bash
git clone https://github.com/smartdu/agentproxy.git
cd agentproxy
npm install
npm run dev
```

### 编译后运行

```bash
npm run build
TARGET_URL=https://api.openai.com npm start
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TARGET_URL` | 代理目标 HTTPS 地址 | `https://api.deepseek.com` |
| `PROXY_PORT` | 代理监听端口 | `3000` |
| `WEB_PORT` | Web UI 监听端口 | `8080` |
| `LOG_DIR` | 日志文件目录 | `logs` |

## 使用方式

### 1. 启动代理

以 DeepSeek 为例：

```bash
TARGET_URL=https://api.deepseek.com npm run dev
```

以 Anthropic 为例：

```bash
TARGET_URL=https://api.anthropic.com npm run dev
```

### 2. 通过代理发送请求

将原本发送到 `https://api.deepseek.com` 的请求改为发送到 `http://localhost:3000`：

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

代理会将请求透明转发到 `https://api.deepseek.com/v1/chat/completions`，路径和参数原样保留。

### 3. 在 Web UI 查看请求

浏览器打开 `http://localhost:8080`：

- **顶栏**：消息总数、SSE 消息数、错误数，可配置自动刷新间隔
- **左栏**：消息列表，显示序号、HTTP 方法、路径、状态码、耗时
- **右栏**：消息详情，包含请求/响应 Headers、Body，SSE 逐 chunk 展示

### 4. 使用 OpenAI SDK

以 Python 为例，只需修改 `base_url`：

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-api-key",
    base_url="http://localhost:3000/v1"  # 指向代理
)

response = client.chat.completions.create(
    model="deepseek-chat",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)

for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

## REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/messages` | 获取全部消息 |
| `GET` | `/api/messages/latest?after={timestamp}` | 获取指定时间戳之后的增量消息 |
| `GET` | `/api/messages/{id}` | 获取单条消息详情 |
| `GET` | `/api/stats` | 获取统计信息 |
| `DELETE` | `/api/messages` | 清空所有消息 |

## 运行测试

使用 DeepSeek API 验证 OpenAI API 兼容性：

```bash
TARGET_URL=https://api.deepseek.com API_KEY=your-deepseek-api-key npm test
```

测试覆盖：
- 非流式聊天补全
- SSE 流式聊天补全
- 模型列表接口
- Web API 消息记录验证

## 项目结构

```
src/
├── index.ts          # 入口，启动代理服务和 Web 服务
├── server.ts         # 代理服务器 + Web API 服务器
├── store.ts          # 内存消息存储
├── types.ts          # 类型定义
├── test.ts           # 兼容性测试
└── public/
    └── index.html    # Web UI
```
