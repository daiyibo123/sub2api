// Main gateway handler - routes requests to appropriate provider
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey, hashApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl, mapModel } from '../utils/proxy';
import { extractTokenUsage, calculateCost } from '../billing';
import { Account, Channel, Group, ModelMapping } from '../types';

export async function handleGatewayRequest(request: Request, env: Env, failover: FailoverManager): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  
  // Extract API key from Authorization header
  const authHeader = request.headers.get('authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  const apiKey = authHeader.slice(7);
  const keyRecord = await authenticateApiKey(db, apiKey);
  if (!keyRecord) {
    return new Response(JSON.stringify({ error: 'Invalid or disabled API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Get request body
  const body = await request.text();
  let requestBody: any;
  try {
    requestBody = body.trim() ? JSON.parse(body) : {};
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  const model = requestBody.model || '';
  const stream = requestBody.stream === true;
  
  // Determine provider from model name or URL path
  let provider = 'openai';
  const pathLower = url.pathname.toLowerCase();
  
  if (pathLower.includes('/claude') || pathLower.includes('/anthropic') || model.startsWith('claude-')) {
    provider = 'anthropic';
  } else if (pathLower.includes('/grok') || model.startsWith('grok-')) {
    provider = 'xai';
  } else if (pathLower.includes('/openai') || pathLower.includes('/chat/completions') || pathLower.includes('/responses')) {
    provider = 'openai';
  }
  
  // Get all enabled accounts for this provider
  let accounts = await db.listEnabledAccounts();
  accounts = accounts.filter(a => a.provider === provider && a.enabled);
  
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Load supporting data
  const [channelsRaw, groupsRaw, mappingsRaw] = await Promise.all([
    db.listChannels(),
    db.listGroups(),
    db.listModelMappings()
  ]);
  
  const channels = new Map(channelsRaw.map(c => [c.id, c]));
  const groups = new Map(groupsRaw.map(g => [g.id, g]));
  const mappings = mappingsRaw;
  
  // Apply model mapping
  let upstreamModel = mapModel(model, mappings);
  
  // Select account with failover
  const selection = failover.selectAccount(accounts, channels, groups);
  if (!selection) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, channel, group, stats } = selection;
  
  // Build upstream URL
  const baseUrl = getUpstreamBaseUrl(account.base_url, provider);
  let upstreamPath = url.pathname;
  
  // Map paths for different providers
  if (provider === 'anthropic') {
    // Ensure correct Anthropic path
    if (!upstreamPath.includes('/v1/messages')) {
      upstreamPath = '/v1/messages';
    }
  } else if (provider === 'openai' && upstreamPath.includes('/chat/completions')) {
    // Keep as is for OpenAI
  } else if (provider === 'xai') {
    // Grok uses OpenAI-compatible endpoints
    if (!upstreamPath.includes('/chat/completions')) {
      upstreamPath = '/v1/chat/completions';
    }
  }
  
  const upstreamUrl = new URL(`${baseUrl}${upstreamPath}`);
  if (provider === 'anthropic') upstreamUrl.searchParams.set('beta', 'true');
  
  // Build headers
  const headers = buildUpstreamHeaders(request.headers, provider, account.api_key, account.base_url, account.client_spoofing);
  
  // Update request body with mapped model
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  const upstreamBody = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : (upstreamModel !== model ? JSON.stringify(requestBody) : body);
  
  // Record start time
  const startTime = Date.now();
  let isError = false;
  let errorMessage = '';
  let responseStatus = 200;
  
  try {
    // Make upstream request
    const proxyResponse = await proxyRequest({
      url: upstreamUrl.toString(),
      method: request.method,
      headers,
      body: new ReadableStream({
        start(controller) {
          if (upstreamBody !== undefined) controller.enqueue(new TextEncoder().encode(upstreamBody));
          controller.close();
        }
      })
    });
    
    responseStatus = proxyResponse.status;
    isError = responseStatus >= 400;
    if (isError && failover.shouldFailover({ status: responseStatus }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => '');
      failover.recordRequest(account.id, channel.id, group.id, true);
      return handleFailover(upstreamBody, request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, `Upstream returned ${responseStatus}`);
    }
    
    if (stream && proxyResponse.body) {
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: responseStatus, error_message: isError ? 'Upstream error' : '', latency_ms: Date.now() - startTime }).catch(() => {});
      return new Response(proxyResponse.body, { status: proxyResponse.status, headers: { ...proxyResponse.headers, 'content-type': proxyResponse.headers['content-type'] || 'text/event-stream' } });
    }
    
    // For non-streaming responses, extract usage and record
    const responseText = await proxyResponse.text();
    let responseBody: any = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Non-JSON response
    }
    
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const cost = calculateCost(provider, upstreamModel, 
      responseBody?.usage?.prompt_tokens || 0,
      responseBody?.usage?.completion_tokens || 0
    );
    
    // Record usage and request log
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {});
    }
    db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: responseStatus, error_message: isError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime }).catch(() => {});
    
    db.createRequestLog({
      account_id: account.id,
      channel_id: channel.id,
      group_id: group.id,
      model: upstreamModel,
      status: responseStatus,
      error_message: isError ? errorMessage : '',
      latency_ms: Date.now() - startTime
    }).catch(() => {});
    
    // Record for failover
    failover.recordRequest(account.id, channel.id, group.id, isError);
    
    // Return response
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        'content-type': 'application/json'
      }
    });
    
  } catch (error) {
    isError = true;
    errorMessage = error instanceof Error ? error.message : 'Unknown error';
    responseStatus = 502;
    
    // Record failover
    failover.recordRequest(account.id, channel.id, group.id, true);
    
    // Try to failover to next account
    return handleFailover(upstreamBody, request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, errorMessage);
  }
}

// Handle failover to next account
async function handleFailover(
  body: string | undefined,
  request: Request,
  env: Env,
  failover: FailoverManager,
  keyRecord: any,
  accounts: Account[],
  channels: Map<number, Channel>,
  groups: Map<number, Group>,
  mappings: ModelMapping[],
  provider: string,
  upstreamModel: string,
  stream: boolean,
  errorMessage: string
): Promise<Response> {
  const db = createDatabase(env.DB);
  
  // Try next account (max 3 retries)
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    // Get next healthy account
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = failover.selectAccount(nextAccounts, channels, groups);
    
    if (!selection) {
      break;
    }
    
    const { account, channel, group } = selection;
    attempted.add(account.id);
    
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, provider);
      const url = new URL(request.url);
      let upstreamPath = url.pathname;
      
      if (provider === 'anthropic' && !upstreamPath.includes('/v1/messages')) {
        upstreamPath = '/v1/messages';
      } else if (provider === 'xai' && !upstreamPath.includes('/chat/completions')) {
        upstreamPath = '/v1/chat/completions';
      }
      
      const retryUrl = new URL(`${baseUrl}${upstreamPath}`);
      if (provider === 'anthropic') retryUrl.searchParams.set('beta', 'true');
      const headers = buildUpstreamHeaders(request.headers, provider, account.api_key, account.base_url, account.client_spoofing);
      
      const proxyResponse = await proxyRequest({
        url: retryUrl.toString(),
        method: request.method,
        headers,
        body: new ReadableStream({
          start(controller) {
            if (body !== undefined) controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          }
        })
      });
      
      const responseText = await proxyResponse.text();
      
      const isError = proxyResponse.status >= 400;
      if (isError && failover.shouldFailover({ status: proxyResponse.status }) && i < maxRetries - 1) {
        failover.recordRequest(account.id, channel.id, group.id, true);
        continue;
      }
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({
        account_id: account.id,
        channel_id: channel.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? 'Upstream error' : '',
        latency_ms: 0
      }).catch(() => {});
      
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, 'content-type': 'application/json' }
      });
      
    } catch (retryError) {
      failover.recordRequest(account.id, channel.id, group.id, true);
      continue;
    }
  }
  
  // All retries failed
  return new Response(JSON.stringify({ 
    error: 'All accounts failed',
    message: errorMessage 
  }), { 
    status: 502, 
    headers: { 'Content-Type': 'application/json' } 
  });
}
