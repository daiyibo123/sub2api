// OpenAI-compatible route handler (OpenAI, Responses, Chat Completions)
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl } from '../utils/proxy';
import { getModelFromHeader } from '../utils/headers';
import { extractTokenUsage, calculateCost } from '../billing';
import { Account, Channel, Group, ModelMapping } from '../types';

export async function handleOpenAIRequest(request: Request, env: Env, failover: FailoverManager): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  
  // Extract API key
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
    requestBody = JSON.parse(body);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  
  const model = requestBody.model || getModelFromHeader(request) || '';
  const stream = requestBody.stream === true;
  const isResponses = url.pathname.includes('/responses');
  
  // Determine endpoint
  let endpoint = '/v1/chat/completions';
  if (isResponses) {
    endpoint = '/v1/responses';
  }
  
  // Get OpenAI-compatible accounts
  let accounts = await db.listEnabledAccounts();
  accounts = accounts.filter(a => (a.provider === 'openai' || a.provider === 'xai') && a.enabled);
  
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
  let upstreamModel = model;
  for (const mapping of mappings) {
    if (mapping.enabled && mapping.requested_model === model && (mapping.provider === 'openai' || mapping.provider === 'xai')) {
      upstreamModel = mapping.upstream_model;
      break;
    }
  }
  
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  
  // Select account with failover
  const selection = failover.selectAccount(accounts, channels, groups);
  if (!selection) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, channel, group } = selection;
  const provider = account.provider as 'openai' | 'xai';
  
  // Build upstream request
  const baseUrl = getUpstreamBaseUrl(account.base_url, provider);
  const upstreamUrl = `${baseUrl}${endpoint}`;
  const headers = buildUpstreamHeaders(request.headers, provider, account.api_key, account.base_url, account.client_spoofing);
  
  const startTime = Date.now();
  
  try {
    const proxyResponse = await proxyRequest({
      url: upstreamUrl,
      method: request.method,
      headers,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody)));
          controller.close();
        }
      })
    });
    
    const isError = proxyResponse.status >= 400;
    if (isError && failover.shouldFailover({ status: proxyResponse.status }) && accounts.length > 1) {
      await proxyResponse.text().catch(() => '');
      failover.recordRequest(account.id, channel.id, group.id, true);
      return handleFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`);
    }
    if (stream && proxyResponse.body) {
      failover.recordRequest(account.id, channel.id, group.id, isError);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: isError ? 'Upstream error' : '', latency_ms: Date.now() - startTime }).catch(() => {});
      return new Response(proxyResponse.body, { status: proxyResponse.status, headers: { ...proxyResponse.headers, 'content-type': proxyResponse.headers['content-type'] || 'text/event-stream' } });
    }
    const responseText = await proxyResponse.text();
    let responseBody: any = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Non-JSON response
    }
    
    // Calculate cost
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const cost = calculateCost(provider, upstreamModel, promptTokens, completionTokens);
    
    // Record usage
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {});
    }
    db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider, prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime }).catch(() => {});
    
    // Record request log
    db.createRequestLog({
      account_id: account.id,
      channel_id: channel.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || 'Error' : '',
      latency_ms: Date.now() - startTime
    }).catch(() => {});
    
    // Record for failover
    failover.recordRequest(account.id, channel.id, group.id, isError);
    
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        'content-type': 'application/json'
      }
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    failover.recordRequest(account.id, channel.id, group.id, true);
    
    // Try failover
    return handleFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), channels, groups, mappings, provider, upstreamModel, stream, errorMessage);
  }
}

// Failover handler
async function handleFailover(
  body: string,
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
  const url = new URL(request.url);
  const isResponses = url.pathname.includes('/responses');
  let endpoint = '/v1/chat/completions';
  if (isResponses) endpoint = '/v1/responses';
  
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = failover.selectAccount(nextAccounts, channels, groups);
    
    if (!selection) break;
    
    const { account, channel, group } = selection;
    attempted.add(account.id);
    const currentProvider = account.provider as 'openai' | 'xai';
    
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, currentProvider);
      const upstreamUrl = `${baseUrl}${endpoint}`;
      const headers = buildUpstreamHeaders(request.headers, currentProvider, account.api_key, account.base_url, account.client_spoofing);
      const proxyResponse = await proxyRequest({
        url: upstreamUrl,
        method: request.method,
        headers,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
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
        error_message: isError ? errorMessage : '',
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
  
  return new Response(JSON.stringify({ error: 'All accounts failed', message: errorMessage }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
