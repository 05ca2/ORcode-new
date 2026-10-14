// ORcode - 模型客户端实现 (纯 JS)
// 提供模型 API 调用的抽象层

// 模型客户接口
class OpenAIController {
  constructor(apiKey, modelName, baseUrl) {
    this.apiKey = apiKey;
    this.modelName = modelName || 'gpt-4';
    this.baseUrl = baseUrl || 'https://api.openai.com/v1';
  }

  async call(prompt, tools, abortSignal) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: [{ role: 'user', content: prompt }],
        tools: tools || undefined
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API Error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }
}

class AnthropicController {
  constructor(apiKey, modelName) {
    this.apiKey = apiKey;
    this.modelName = modelName || 'claude-3';
    this.baseUrl = 'https://api.anthropic.com/v1';
  }

  async call(prompt, tools, abortSignal) {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
        'X-Anthropic-Version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.modelName,
        messages: [{ role: 'user', content: prompt }],
        tools: tools || undefined,
        max_tokens: 4096
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API Error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }
}

class OllamaController {
  constructor(modelName) {
    this.modelName = modelName || 'phi3';
    this.baseUrl = 'http://localhost:11434';
  }

  async call(prompt, tools, abortSignal) {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.modelName,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama API Error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.message.content;
  }
}

class GeminiController {
  constructor(apiKey, modelName) {
    this.apiKey = apiKey;
    this.modelName = modelName || 'gemini-pro';
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1';
  }

  async call(prompt, tools, abortSignal) {
    const url = `${this.baseUrl}/models/${this.modelName}:generateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 4096
        }
      }),
      signal: abortSignal
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API Error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }
}

// 客户端创建函数
// config: { apiKey, modelName(显示名), modelId(实际模型ID), baseUrl }
function createModelClient(provider, config) {
  const modelId = config.modelId || config.modelName || 'gpt-4';
  const baseUrl = config.baseUrl;
  switch (provider.toLowerCase()) {
    case 'openai':
      return new OpenAIController(config.apiKey, modelId, baseUrl);
    case 'anthropic':
    case 'claude':
      return new AnthropicController(config.apiKey, modelId);
    case 'ollama':
      return new OllamaController(modelId);
    case 'google':
    case 'gemini':
      return new GeminiController(config.apiKey, modelId);
    default:
      // 自定义供应商默认走 OpenAI 兼容协议
      return new OpenAIController(config.apiKey, modelId, baseUrl);
  }
}

function getController(provider, config) {
  return createModelClient(provider, config);
}

module.exports = {
  OpenAIController,
  AnthropicController,
  OllamaController,
  GeminiController,
  createModelClient,
  getController
};
