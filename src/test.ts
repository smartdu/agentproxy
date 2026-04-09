/**
 * Test script: Verify OpenAI API compatibility through the proxy using DeepSeek.
 *
 * Usage:
 *   TARGET_URL=https://api.deepseek.com ts-node-dev src/test.ts
 *
 * Environment:
 *   TARGET_URL - The upstream API base URL (default: https://api.deepseek.com)
 *   API_KEY    - Your DeepSeek API key
 */

const API_KEY = process.env.API_KEY || process.env.DEEPSEEK_API_KEY || '';
const PROXY_BASE = process.env.PROXY_BASE || 'http://localhost:3000';
const TARGET_URL = process.env.TARGET_URL || 'https://api.deepseek.com';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testNonStreamChat() {
  console.log('\n=== Test 1: Non-streaming chat completion ===');
  const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Say "hello world" and nothing else.' }],
      max_tokens: 20,
      stream: false,
    }),
  });

  const data: any = await res.json();
  console.log('Status:', res.status);
  console.log('Response:', JSON.stringify(data, null, 2));

  if (data.choices && data.choices[0]?.message?.content) {
    console.log('✅ Non-streaming chat: PASS');
  } else {
    console.log('❌ Non-streaming chat: FAIL - unexpected response format');
  }
}

async function testStreamChat() {
  console.log('\n=== Test 2: Streaming chat completion (SSE) ===');
  const res = await fetch(`${PROXY_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'Count from 1 to 5, one number per line.' }],
      max_tokens: 50,
      stream: true,
    }),
  });

  console.log('Status:', res.status);
  console.log('Content-Type:', res.headers.get('content-type'));

  if (!res.body) {
    console.log('❌ Streaming chat: FAIL - no response body');
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let chunks = 0;
  let fullContent = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    chunks++;
    // Parse SSE data lines
    for (const line of text.split('\n')) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) fullContent += delta;
        } catch {
          // ignore parse errors for incomplete chunks
        }
      }
    }
  }

  console.log('SSE chunks received:', chunks);
  console.log('Full content:', fullContent);
  console.log(chunks > 1 ? '✅ Streaming chat (SSE): PASS' : '❌ Streaming chat (SSE): FAIL - expected multiple chunks');
}

async function testModelsList() {
  console.log('\n=== Test 3: List models ===');
  const res = await fetch(`${PROXY_BASE}/v1/models`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });

  const data: any = await res.json();
  console.log('Status:', res.status);

  if (data.data && Array.isArray(data.data)) {
    console.log('Models count:', data.data.length);
    console.log('✅ List models: PASS');
  } else {
    console.log('❌ List models: FAIL - unexpected response format');
  }
}

async function testWebAPI() {
  console.log('\n=== Test 4: Web API messages ===');
  await sleep(500); // Wait for proxy to log messages

  const res = await fetch('http://localhost:8080/api/messages');
  const messages = (await res.json()) as any[];
  console.log('Messages count:', messages.length);

  const statsRes = await fetch('http://localhost:8080/api/stats');
  const stats: any = await statsRes.json();
  console.log('Stats:', JSON.stringify(stats));

  if (messages.length > 0) {
    console.log('✅ Web API: PASS');
  } else {
    console.log('❌ Web API: FAIL - no messages recorded');
  }
}

async function main() {
  if (!API_KEY) {
    console.error('Error: API_KEY or DEEPSEEK_API_KEY environment variable is required');
    console.error('Usage: API_KEY=your-key ts-node-dev src/test.ts');
    process.exit(1);
  }

  console.log(`Proxy: ${PROXY_BASE} -> ${TARGET_URL}`);
  console.log('Starting tests...\n');

  try {
    await testModelsList();
    await testNonStreamChat();
    await testStreamChat();
    await testWebAPI();

    console.log('\n=== All tests completed ===');
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}

main();
