// Claude Messages route handler
import type { Env } from '../index';
import { createDatabase } from '../db';
import { authenticateApiKey } from '../auth';
import { FailoverManager } from '../failover';
import { proxyRequest, buildUpstreamHeaders, getUpstreamBaseUrl, findModelMapping, resolveUpstreamCredentials , accountRateMultiplier } from '../utils/proxy';
import { streamWithRecording } from '../utils/record';
import { defer, Deferrable } from '../utils/background';
import { getModelFromHeader } from '../utils/headers';
import { extractTokenUsage, calculateCost } from '../billing';
import { Account, Group, ModelMapping } from '../types';

export async function handleClaudeRequest(request: Request, env: Env, failover: FailoverManager, ctx?: Deferrable): Promise<Response> {
  const db = createDatabase(env.DB);
  const url = new URL(request.url);
  
  // Extract API key
  const authHeader = request.headers.get('authorization');
  const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : request.headers.get('x-api-key');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Missing API key' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }
  
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

  // A client key may be pinned to one group. That is a hard constraint: serving
  // it from another group would bill and route traffic somewhere the operator
  // deliberately excluded, so an empty result fails instead of falling back.
  const keyGroupId = Number(keyRecord?.group_id) || 0;
  if (keyGroupId) {
    accounts = accounts.filter(account => Number(account.group_id) === keyGroupId);
    if (accounts.length === 0) {
      return new Response(JSON.stringify({
        error: 'No available accounts',
        message: '该 API 密钥绑定的分组下没有可用账号'
      }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }
  }
  
  if (accounts.length === 0) {
    return new Response(JSON.stringify({ error: 'No available Anthropic accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  // Load supporting data
  const [groupsRaw, mappingsRaw] = await Promise.all([
    db.listGroups(),
    db.listModelMappings()
  ]);
  const groups = new Map(groupsRaw.map(g => [g.id, g]));
  const mappings = mappingsRaw;
  
  // Apply model mapping
  const mapping = findModelMapping(model, mappings, 'anthropic');
  let upstreamModel = mapping?.requested_model.endsWith('*')
    ? mapping.upstream_model + model.slice(mapping.requested_model.length - 1)
    : (mapping?.upstream_model || model);
  const preferredGroupId = mapping?.group_id || undefined;
  
  if (upstreamModel && upstreamModel !== model && requestBody.model) {
    requestBody.model = upstreamModel;
  }
  
  // Select account with failover
  const selection = await failover.selectAccount(accounts, groups, preferredGroupId);
  if (!selection) {
    return new Response(JSON.stringify({ error: 'No available accounts' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  
  const { account, group } = selection;
  
  // Build upstream request
  const credentials = resolveUpstreamCredentials(account);
  const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, 'anthropic');
  const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
  const headers = buildUpstreamHeaders(request.headers, 'anthropic', credentials.apiKey, credentials.baseUrl, account.client_spoofing);
  
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
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: proxyResponse.status, error_message: `Upstream returned ${proxyResponse.status}`, latency_ms: Date.now() - startTime }));
      return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, upstreamModel, stream, `Upstream returned ${proxyResponse.status}`, preferredGroupId, startTime, ctx);
    }
    if (stream && proxyResponse.body) {
      // Streaming records usage from the stream's completion callback so
      // first-byte latency is not delayed by bookkeeping.
      return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
        db, failover, keyRecordId: keyRecord.id,
        accountId: account.id, groupId: group.id,
        provider: 'anthropic', model: upstreamModel,
        rateMultiplier: accountRateMultiplier(account),
        startedAt: startTime,
        ctx
      });
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
    const cost = calculateCost('anthropic', upstreamModel, promptTokens, completionTokens);
    
    // Record usage
    if (cost > 0) {
      defer(ctx, db.incrementApiKeyUsage(keyRecord.id, cost));
    }
    defer(ctx, db.createUsageRecord({ api_key_id: keyRecord.id, model: upstreamModel, provider: 'anthropic', prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens, cost, status: proxyResponse.status, error_message: isError ? responseBody?.error?.message || 'Error' : '', latency_ms: Date.now() - startTime }));
    
    // Record request log
    defer(ctx, db.createRequestLog({
      account_id: account.id,
      group_id: group.id,
      model: upstreamModel,
      status: proxyResponse.status,
      error_message: isError ? responseBody?.error?.message || 'Error' : '',
      latency_ms: Date.now() - startTime
    }));
    
    // Record for failover
    failover.recordRequest(account.id, group.id, isError);
    
    return new Response(responseText, {
      status: proxyResponse.status,
      headers: {
        ...proxyResponse.headers,
        'content-type': 'application/json'
      }
    });
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    failover.recordRequest(account.id, group.id, true);
    defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: errorMessage, latency_ms: Date.now() - startTime }));
    
    // Try failover
    return handleClaudeFailover(JSON.stringify(requestBody), request, env, failover, keyRecord, accounts.filter(candidate => candidate.id !== account.id), groups, mappings, upstreamModel, stream, errorMessage, preferredGroupId, startTime, ctx);
  }
}

// Claude-specific failover
async function handleClaudeFailover(
  body: string,
  request: Request,
  env: Env,
  failover: FailoverManager,
  keyRecord: any,
  accounts: Account[],
  groups: Map<number, Group>,
  mappings: ModelMapping[],
  upstreamModel: string,
  stream: boolean,
  errorMessage: string,
  preferredGroupId?: number,
  originStart: number = Date.now(),
  ctx?: Deferrable
): Promise<Response> {
  const db = createDatabase(env.DB);
  
  const attempted = new Set<number>();
  const maxRetries = Math.min(Math.max(Number(env.MAX_SAME_ACCOUNT_RETRIES) || 3, 1), 5);
  for (let i = 0; i < maxRetries; i++) {
    const nextAccounts = accounts.filter(a => a.enabled && !attempted.has(a.id));
    const selection = await failover.selectAccount(nextAccounts, groups, preferredGroupId);
    
    if (!selection) break;
    
    const { account, group } = selection;
    attempted.add(account.id);
    
    try {
      const credentials = resolveUpstreamCredentials(account);
      const baseUrl = getUpstreamBaseUrl(credentials.baseUrl, 'anthropic');
      const upstreamUrl = `${baseUrl}/v1/messages?beta=true`;
      const headers = buildUpstreamHeaders(request.headers, 'anthropic', credentials.apiKey, credentials.baseUrl, account.client_spoofing);
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
        failover.recordRequest(account.id, group.id, true);
        continue;
      }
      
      // Streaming records its own request log and usage from the stream
      // completion callback, so return before the non-streaming bookkeeping.
      if (stream && !isError && proxyResponse.body) {
        return streamWithRecording(proxyResponse.body, proxyResponse.status, proxyResponse.headers, {
          db, failover, keyRecordId: keyRecord.id,
          accountId: account.id, groupId: group.id,
          provider: 'anthropic', model: upstreamModel,
          rateMultiplier: accountRateMultiplier(account),
          startedAt: originStart,
          ctx
        });
      }

      failover.recordRequest(account.id, group.id, isError);
      defer(ctx, db.createRequestLog({
        account_id: account.id,
        group_id: group.id,
        model: upstreamModel,
        status: proxyResponse.status,
        error_message: isError ? errorMessage : '',
        latency_ms: 0
      }));
      const responseText = await proxyResponse.text();
      
      return new Response(responseText, {
        status: proxyResponse.status,
        headers: { ...proxyResponse.headers, 'content-type': 'application/json' }
      });
      
    } catch (retryError) {
      failover.recordRequest(account.id, group.id, true);
      defer(ctx, db.createRequestLog({ account_id: account.id, group_id: group.id, model: upstreamModel, status: 502, error_message: retryError instanceof Error ? retryError.message : 'Upstream request failed', latency_ms: 0 }));
      continue;
    }
  }
  
  return new Response(JSON.stringify({ error: 'All Anthropic accounts failed', message: errorMessage }), { status: 502, headers: { 'Content-Type': 'application/json' } });
}
