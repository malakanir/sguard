import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtPayload } from '../auth/jwt.strategy';
import {
  DriftDetectedEvent,
  EVENT_DRIFT_DETECTED,
  EVENT_RULE_HIGH,
  EVENT_SYNC_CHANGED,
  GroupEventBase,
  RuleHighEvent,
  SyncChangedEvent,
} from '../events/app-events';

export const userRoom = (userId: string) => `user:${userId}`;

/** Membuang field internal (pemilik dan audience) sebelum dikirim ke browser. */
function publicPayload<T extends GroupEventBase>(event: T): Omit<T, 'ownerId' | 'audience'> {
  const { ownerId: _owner, audience: _audience, ...rest } = event;
  return rest;
}

/**
 * WebSocket di /events. JWT diperiksa saat handshake (auth.token).
 * Setiap event hanya dikirim ke pemilik group dan member yang dibagikan.
 */
@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      const allowed = process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000';
      callback(null, !origin || origin === allowed);
    },
    credentials: true,
  },
})
export class RealtimeGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    try {
      if (!token) throw new Error('missing token');
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      client.data.userId = payload.sub;
      await client.join(userRoom(payload.sub));
      client.emit('ready', { userId: payload.sub });
    } catch {
      client.emit('error_message', { message: 'Token tidak valid.' });
      client.disconnect(true);
    }
  }

  @OnEvent(EVENT_RULE_HIGH)
  onRuleHigh(event: RuleHighEvent): void {
    this.server.to(event.audience.map(userRoom)).emit(EVENT_RULE_HIGH, publicPayload(event));
  }

  @OnEvent(EVENT_SYNC_CHANGED)
  onSyncChanged(event: SyncChangedEvent): void {
    this.server.to(event.audience.map(userRoom)).emit(EVENT_SYNC_CHANGED, publicPayload(event));
  }

  @OnEvent(EVENT_DRIFT_DETECTED)
  onDriftDetected(event: DriftDetectedEvent): void {
    this.server.to(event.audience.map(userRoom)).emit(EVENT_DRIFT_DETECTED, publicPayload(event));
  }
}
