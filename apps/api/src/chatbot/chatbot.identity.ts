import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import type { Role } from '@prisma/client';
import type { Request } from 'express';

export interface ChatActor {
  id: string;
  role: Role;
}
export interface ChatHttpRequest extends Request {
  chatActor?: ChatActor;
}

// Reuses CivicLoop's cookie/Bearer JWT format, without the legacy demo bypass.
// The database, not a token role or model argument, establishes the active identity.
@Injectable()
export class ChatbotIdentityGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<ChatHttpRequest>();
    const cookies = req.cookies as Record<string, unknown> | undefined;
    const cookie = cookies?.civic_session;
    const authorization = req.headers.authorization;
    if (cookie === undefined && authorization === undefined) return true;
    const token =
      typeof cookie === 'string'
        ? cookie
        : authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    const secret =
      this.config.get<string>('JWT_SECRET') ||
      (this.config.get<string>('NODE_ENV') !== 'production'
        ? 'dev_jwt_secret_change_me'
        : undefined);
    if (!token || !secret || token === 'citizen-demo-token')
      throw new UnauthorizedException(
        'Please sign in again to use personal complaint retrieval.',
      );
    let subject: string;
    try {
      const payload = await this.jwt.verifyAsync<{ sub?: unknown }>(token, {
        secret,
      });
      if (typeof payload.sub !== 'string' || !payload.sub)
        throw new Error('Missing subject');
      subject = payload.sub;
    } catch {
      throw new UnauthorizedException(
        'Please sign in again to use personal complaint retrieval.',
      );
    }
    let user: { id: string; role: Role; isActive: boolean } | null;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: subject },
        select: { id: true, role: true, isActive: true },
      });
    } catch {
      throw new ServiceUnavailableException(
        'Account verification is temporarily unavailable.',
      );
    }
    if (!user?.isActive)
      throw new UnauthorizedException('Please sign in with an active account.');
    req.chatActor = { id: user.id, role: user.role };
    return true;
  }
}
