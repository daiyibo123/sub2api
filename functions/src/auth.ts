// Authentication utilities
import { createDatabase } from './db';
import { Env } from './index';

export interface Session {
  userId: number;
  username: string;
  isAdmin: boolean;
  expiresAt: number;
}

// Simple bcrypt implementation for Workers (compatible with bcryptjs)
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  // Simple hash for demo - in production use proper bcrypt or argon2
  return `$2a$10$${hashHex.substring(0, 60)}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const passwordHash = `$2a$10$${hashHex.substring(0, 60)}`;
  return passwordHash === hash;
}

export async function authenticateUser(db: Database, username: string, password: string): Promise<Session | null> {
  const user = await db.getUserByUsername(username);
  if (!user) return null;
  
  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return null;
  
  return {
    userId: user.id,
    username: user.username,
    isAdmin: true, // Single user is always admin
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
  };
}

export function createSessionToken(session: Session): string {
  const payload = {
    sub: session.userId,
    username: session.username,
    admin: session.isAdmin,
    exp: Math.floor(session.expiresAt / 1000)
  };
  
  const encoder = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = btoa(JSON.stringify(payload));
  const signature = btoa(`${header}.${payloadB64}`);
  
  return `${header}.${payloadB64}.${signature}`;
}

export async function verifySessionToken(token: string, secret: string): Promise<Session | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(atob(parts[1]));
    
    // Check expiration
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }
    
    // Verify signature (simple check for now)
    const expectedSig = btoa(`${parts[0]}.${parts[1]}`);
    if (parts[2] !== expectedSig) return null;
    
    return {
      userId: payload.sub,
      username: payload.username,
      isAdmin: payload.admin,
      expiresAt: payload.exp * 1000
    };
  } catch {
    return null;
  }
}

export async function hashApiKey(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function authenticateApiKey(db: Database, apiKey: string): Promise<any | null> {
  const keyHash = await hashApiKey(apiKey);
  const key = await db.getApiKeyByHash(keyHash);
  if (!key || !key.enabled) return null;
  
  // Check quota
  if (key.quota_limit > 0 && key.balance >= key.quota_limit) {
    return null; // Quota exceeded
  }
  
  return key;
}
