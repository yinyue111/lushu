import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAiEndpoint } from '../../server/ai/generate.mjs';

test('OpenAI-compatible endpoint keeps provider version roots (domestic providers)', () => {
  assert.equal(openAiEndpoint('https://api.example.com', 'responses'), 'https://api.example.com/v1/responses');
  assert.equal(openAiEndpoint('https://api.example.com/v1/', 'chat_completions'), 'https://api.example.com/v1/chat/completions');
  assert.equal(
    openAiEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1', 'chat_completions'),
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
  );
  assert.equal(openAiEndpoint('https://ark.cn-beijing.volces.com/api/v3', 'chat_completions'), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(openAiEndpoint('https://open.bigmodel.cn/api/paas/v4', 'chat_completions'), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(openAiEndpoint('https://api.deepseek.com', 'chat_completions'), 'https://api.deepseek.com/v1/chat/completions');
  assert.throws(() => openAiEndpoint('not a url', 'responses'));
});
