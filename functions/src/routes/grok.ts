// Grok route handler (OpenAI-compatible)
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl, findModelMapping } from '../utils/proxy';
import { getModelFromHeader } from '../utils/headers';
import { extractTokenUsage, calculateCost } from '../billing';
import { Account, Channel, Group, ModelMapping } from '../types';

export async function handleGrokRequest(request: Request, env: Env, failover: FailoverManager): Promise<Response> {
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
  
  // Get xAI (Grok) accounts
  let accounts = await db.listEnabledAccounts();
  accounts = accounts.filter(a => a.provider === 'xai' && a.enabled);
  
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: 'No available Grok accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
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
  const mapping = findModelMapping(model, mappings, 'xai');
  let upstreamModel = mapping?.requested_model.endsWith('*')
    ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1)
    : (mapping?.upstream_model || model);
  const preferredGroupId = mapping?.group_id || undefined;
  
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  
  // Select account with failover
  const selection = await failover.selectAccount(accounts, channels, groups, preferredGroupId);
  if (!selection) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, channel, group } = selection;
  
  // Build upstream request
  const baseUrl = getUpstreamBaseUrl(account.base_url, 'xai');
  const upstreamUrl = `${baseUrl}/v1/chat/completions`;
  const headers = buildUpstreamHeaders(request.headers, 'xai', account.api_key, account.base_url, account.client_spoofing);
  
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
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }).catch(() => {});
      return handleGrokFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), channels, groups, mappings, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId);
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
    const cost = calculateCost('xai', upstreamModel, promptTokens, completionTokens);
    
    // Record usage
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {});
    }
    db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider: 'xai', prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime }).catch(() => {});
    
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
    db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }).catch(() => {});
    
    // Try failover
    return handleGrokFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), channels, groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId);
  }
}

// Grok-specific failover
async function handleGrokFailover(
  body: string,
  request: Request,
  env: Env,
  failover: FailoverManager,
  keyRecord: any,
  accounts: Account[],
  channels: Map<number, Channel>,
  groups: Map<number, Group>,
  mappings: ModelMapping[],
  upstreamModel: string,
  stream: boolean,
  errorMessage: string,
  preferredGroupId?: number
): Promise<Response> {
  const db = createDatabase(env.DB);
  
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, channels, groups, preferredGroupId);
    
    if (!selection) break;
    
    const { account, channel, group } = selection;
    attempted.add(account.id);
    
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, 'xai');
      const upstreamUrl = `${baseUrl}/v1/chat/completions`;
      const headers = buildUpstreamHeaders(request.headers, 'xai', account.api_key, account.base_url, account.client_spoofing);
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

      if (stream && !isError && proxyResponse.body) {
        return new Response(proxyResponse.body, {
          status: proxyResponse.status,
          headers: { ...proxyResponse.headers, 'content-type': proxyResponse.headers['content-type'] || 'text/event-stream' }
        });
      }
      const responseText = await proxyResponse.text();
      
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, 'content-type': 'application/json' }
      });
      
    } catch (retryError) {
      failover.recordRequest(account.id, channel.id, group.id, true);
      db.createRequestLog({ account_id: account.id, channel_id: channel.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : 'Upstream request failed', latency_ms: 0 }).catch(() => {});
      continue;
    }
  }
  
  return new Response(JSON.stringify({ error: 'All Grok accounts failed', message: errorMessage }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
