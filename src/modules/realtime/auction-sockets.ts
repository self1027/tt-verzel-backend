import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { AuctionEvent, AuctionEventSink, AuctionEventType } from '../../shared/events/auction-events.js';

type Reply = (result: { ok: true } | { ok: false; error: 'INVALID_AUCTION' | 'ROOM_LIMIT' }) => void;
interface ClientEvents {
  'auction:join': (payload: unknown, reply?: Reply) => void;
  'auction:leave': (payload: unknown, reply?: Reply) => void;
}
type ServerEvents = Record<AuctionEventType, (payload: AuctionEvent['data']) => void>;
const subscription = z.object({ auctionId: z.uuid().transform(value => value.toLowerCase()) });
const publicEvents = new Set<AuctionEventType>(['bid:accepted', 'auction:extended', 'auction:ended', 'auction:settled', 'auction:cancelled', 'auction:integrity-warning']);

export function attachAuctionSockets(server: HttpServer, origins: string[]): { events: AuctionEventSink; close(): Promise<void> } {
  const io = new Server<ClientEvents, ServerEvents>(server, {
    cors: { origin: origins, methods: ['GET', 'POST'] },
    allowRequest: (request, callback) => {
      callback(null, request.headers.origin === undefined || origins.includes(request.headers.origin));
    },
  });
  io.on('connection', socket => {
    const rooms = new Set<string>();
    socket.on('auction:join', (payload, reply) => {
      const parsed = subscription.safeParse(payload);
      if (!parsed.success) {
        if (typeof reply === 'function') reply({ ok: false, error: 'INVALID_AUCTION' });
        return;
      }
      const room = `auction:${parsed.data.auctionId}`;
      if (!rooms.has(room) && rooms.size >= 100) {
        if (typeof reply === 'function') reply({ ok: false, error: 'ROOM_LIMIT' });
        return;
      }
      rooms.add(room);
      void socket.join(room);
      if (typeof reply === 'function') reply({ ok: true });
    });
    socket.on('auction:leave', (payload, reply) => {
      const parsed = subscription.safeParse(payload);
      if (!parsed.success) {
        if (typeof reply === 'function') reply({ ok: false, error: 'INVALID_AUCTION' });
        return;
      }
      const room = `auction:${parsed.data.auctionId}`;
      rooms.delete(room);
      void socket.leave(room);
      if (typeof reply === 'function') reply({ ok: true });
    });
  });
  return {
    events: {
      publish(event) {
        if (publicEvents.has(event.type)) io.to(`auction:${event.auctionId.toLowerCase()}`).emit(event.type, { ...event.data, auctionId: event.auctionId.toLowerCase() });
      },
    },
    close: () => new Promise(resolve => { void io.close(() => { resolve(); }); }),
  };
}
