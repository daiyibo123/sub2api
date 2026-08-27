// Claude Messages route handler
import { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl } from '../utils/proxy';
import { getModelFromHeader } from '../utils/headers';
import { extractTokenUsage, calculateCost } from '../billing';
import { Account, Channel, Group, ModelMapping } from '../types';

export async function handleClaudeRequest(request: Request, env: Env, failover: FailoverManager): Promise<Response> {
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
  
  // Get Anthropic accounts
  let accounts = await db.listEnabledAccounts();
  accounts = accounts.filter(a => a.provider === 'anthropic' && a.enabled);
  
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: 'No available Anthropic accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
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
    if (mapping.enabled && mapping.requested_model === model && mapping.provider === 'anthropic') {
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
  
  // Build upstream request
  const baseUrl = getUpstreamBaseUrl(account.base_url, 'anthropic');
  const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
  const headers = buildUpstreamHeaders(request.headers, 'anthropic', account.api_key, account.base_url, account.client_spoofing);
  
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
    const responseText = await proxyResponse.text();
    let responseBody: any = {};
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // Non-JSON response
    }
    
    // Calculate cost
    const { promptTokens, completionTokens, totalTokens } = extractTokenUsage(responseBody, proxyResponse.headers);
    const cost = calculateCost('anthropic', upstreamModel, promptTokens, completionTokens);
    
    // Record usage
    if (cost > 0) {
      db.incrementApiKeyUsage(keyRecord.id, cost).catch(() => {});
    }
    
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
    return handleClaudeFailover(request, env, failover, keyRecord, accounts, channels, groups, mappings, upstreamModel, stream, errorMessage);
  }
}

// Claude-specific failover
async function handleClaudeFailover(
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
  errorMessage: string
): Promise<Response> {
  const db = createDatabase(env.DB);
  
  for (let i = 0; i < 3; i++) {
    const nextAccounts = accounts.filter(a => a.enabled);
    const selection = failover.selectAccount(nextAccounts, channels, groups);
    
    if (!selection) break;
    
    const { account, channel, group } = selection;
    
    try {
      const baseUrl = getUpstreamBaseUrl(account.base_url, 'anthropic');
      const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
      const headers = buildUpstreamHeaders(request.headers, 'anthropic', account.api_key, account.base_url, account.client_spoofing);
      const body = await request.text();
      
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
      
      failover.recordRequest(account.id, channel.id, group.id, !isError);
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
  
  return new Response(JSON.stringify({ error: 'All Anthropic accounts failed', message: errorMessage }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
