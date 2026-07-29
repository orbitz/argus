import { FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';

export interface User {
  id: string;
  githubUserId: number;
  login: string;
  avatarUrl: string | null;
  accessToken: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
  }
}

// Cached token user info (fetched once on startup)
let tokenUser: User | null = null;

export async function initTokenAuth(): Promise<void> {
  try {
    // Fetch user info using the token
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: 'application/json',
        'User-Agent': 'Argus-PR-Review',
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    const userData = await response.json() as {
      id: number;
      login: string;
      avatar_url: string;
    };

    tokenUser = {
      id: 'token-user',
      githubUserId: userData.id,
      login: userData.login,
      avatarUrl: userData.avatar_url,
      accessToken: config.githubToken,
    };

    console.log(`Authenticated as GitHub user: ${userData.login}`);
  } catch (err) {
    console.error('Failed to authenticate with GitHub token:', err);
    throw err;
  }
}

/** The authenticated token user, for background jobs that have no request context. */
export function getTokenUser(): User | null {
  return tokenUser;
}

export async function authMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  request.user = tokenUser;
}

export function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): boolean {
  if (!request.user) {
    reply.status(401).view('error', {
      title: 'Authentication Error - Argus',
      user: null,
      message: 'Invalid or missing GitHub token. Please check your GITHUB_TOKEN environment variable.',
    });
    return false;
  }
  return true;
}
