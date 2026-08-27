// Token counting and billing utilities

// Simple token estimation (chars / 4 for English, chars / 2 for CJK)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // CJK characters
    if ((code >= 0x4E00 && code <= 0x9FFF) || 
        (code >= 0x3400 && code <= 0x4DBF) ||
        (code >= 0x3000 && code <= 0x303F)) {
      tokens += 2;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

// Extract token usage from response headers or body
export function extractTokenUsage(body: any, headers: Headers): { promptTokens: number; completionTokens: number; totalTokens: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  
  // Try to get from body first
  if (body?.usage) {
    promptTokens = body.usage.prompt_tokens || body.usage.input_tokens || 0;
    completionTokens = body.usage.completion_tokens || body.usage.output_tokens || 0;
    totalTokens = body.usage.total_tokens || (promptTokens + completionTokens);
  }
  
  // Fallback to estimation
  if (totalTokens === 0) {
    const inputText = typeof body?.messages === 'string' ? body.messages : JSON.stringify(body?.messages || body?.input || '');
    const outputText = typeof body?.output === 'string' ? body.output : JSON.stringify(body?.output || body?.content || '');
    promptTokens = estimateTokens(inputText);
    completionTokens = estimateTokens(outputText);
    totalTokens = promptTokens + completionTokens;
  }
  
  return { promptTokens, completionTokens, totalTokens };
}

// Calculate cost based on model and provider
export function calculateCost(provider: string, model: string, promptTokens: number, completionTokens: number): number {
  // Default pricing (per 1K tokens, in USD)
  const pricing: Record<string, Record<string, { prompt: number; completion: number }>> = {
    openai: {
      'gpt-4o': { prompt: 2.5, completion: 10 },
      'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
      'gpt-4-turbo': { prompt: 10, completion: 30 },
      'gpt-3.5-turbo': { prompt: 0.5, completion: 1.5 },
      'o1': { prompt: 15, completion: 60 },
      'o1-mini': { prompt: 3, completion: 12 },
      'o3': { prompt: 10, completion: 40 },
    },
    anthropic: {
      'claude-sonnet-4-20250514': { prompt: 3, completion: 15 },
      'claude-3-5-sonnet-20241022': { prompt: 3, completion: 15 },
      'claude-3-5-haiku-20241022': { prompt: 0.8, completion: 4 },
      'claude-3-opus-20240229': { prompt: 15, completion: 75 },
    },
    xai: {
      'grok-2-latest': { prompt: 2, completion: 10 },
      'grok-2': { prompt: 2, completion: 10 },
      'grok-vision-beta': { prompt: 2, completion: 10 },
    }
  };
  
  const providerPricing = pricing[provider] || pricing['openai'];
  const modelPricing = providerPricing[model] || { prompt: 1, completion: 2 }; // Default pricing
  
  const promptCost = (promptTokens / 1000) * modelPricing.prompt;
  const completionCost = (completionTokens / 1000) * modelPricing.completion;
  
  return Math.round((promptCost + completionCost) * 1000000) / 1000000; // Round to 6 decimals
}
