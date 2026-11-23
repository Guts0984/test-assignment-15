import { Emitter } from '@socket.io/redis-emitter';
import { rooms, routeRealtimeEvent, type DomainEvent } from '@helpdesk/shared';
import type { Redis } from 'ioredis';
import type { RealtimePublisher } from './collector';

/**
 * Publishes through Socket.IO's Redis protocol, so every api copy delivers to its own connected sockets.
 * The worker and the api use the same publisher; nothing is stored, a lost event is repaired by the client's refetch on reconnect.
 */
export const createEmitterPublisher = (redis: Redis): RealtimePublisher => {
  const emitter = new Emitter(redis);
  return {
    publish: async (events: readonly DomainEvent[]) => {
      for (const e of events)
        for (const r of routeRealtimeEvent(e)) emitter.to(r.room).emit(r.event, r.payload);
    },
    revokeStaffAccess: async (ticketId) => {
      const room = rooms.ticketStaff(ticketId);
      emitter.to(room).emit('ticket:access-changed', { ticketId });
      emitter.in(room).socketsLeave(room);
    },
    revokeCustomerAccess: async (ticketId) => {
      emitter.in(rooms.ticketCustomer(ticketId)).disconnectSockets(true);
    },
  };
};

/** Tells one user's sockets to leave a team room (membership removed) or to disconnect (account disabled). */
export const createUserAccessRevoker = (redis: Redis) => {
  const emitter = new Emitter(redis);
  return {
    leaveTeam: (userId: string, teamId: string): void => {
      emitter.in(rooms.user(userId)).socketsLeave(rooms.team(teamId));
    },
    /** Cuts the sockets of one login session (logout on one device) on every api copy. */
    disconnectSession: (sessionId: string): void => {
      emitter.in(rooms.session(sessionId)).disconnectSockets(true);
    },
    disconnectUser: (userId: string): void => {
      emitter.in(rooms.user(userId)).disconnectSockets(true);
    },
  };
};
