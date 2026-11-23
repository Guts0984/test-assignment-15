import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { client } from './attacker/client';
import { connectSocket, type TestSocket } from './attacker/socket';
import {
  createTeamRow,
  createUserRow,
  login,
  setTestClock,
  startApi,
  testDb,
  type RunningApi,
} from './helpers/api';
import { createMailbox, receiveTicket } from './helpers/tickets';

// Serial suite: moves the shared test clock past the 15 minute lifetime of an access token.
let a: RunningApi;
let b: RunningApi;
const db = testDb();
const sockets: TestSocket[] = [];
beforeAll(async () => {
  [a, b] = [
    await startApi({ API_INSTANCE_ID: 'api-1' }),
    await startApi({ API_INSTANCE_ID: 'api-2' }),
  ];
});
afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
});
afterAll(async () => {
  await setTestClock(a, { offsetMs: 0 });
  await Promise.all([a.close(), b.close()]);
});

const world = async () => {
  const team = await createTeamRow(db);
  const box = await createMailbox(team.id);
  const agent = await login(
    a,
    await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] }),
  );
  const t = await receiveTicket(a, box);
  return { agent, ticketId: t.ticketId };
};

describe('long-lived sockets (review F5, F13)', () => {
  it('a socket whose handshake token has expired can still subscribe while the account is valid', async () => {
    const w = await world();
    const s = connectSocket(a.url, { token: w.agent.accessToken });
    sockets.push(s);
    await s.connected();
    await setTestClock(a, { advanceMs: 20 * 60_000 }); // the 15 minute token is now expired
    const r = await s.emit<{ ok: boolean }>('ticket:subscribe', {
      ticketId: w.ticketId,
      lastSeq: 0,
    });
    expect(r.ok).toBe(true);
    await setTestClock(a, { offsetMs: 0 });
  });

  it('logging out on one device leaves the same account signed in on another (review F21)', async () => {
    const team = await createTeamRow(db);
    const user = await createUserRow(db, { teams: [{ teamId: team.id, role: 'agent' }] });
    const phone = await login(a, user);
    const laptop = await login(a, user);
    const watching = connectSocket(b.url, { token: laptop.accessToken });
    sockets.push(watching);
    await watching.connected();
    const out = await client({ baseUrl: a.url }).post(
      '/api/v1/auth/logout',
      {},
      {
        headers: { cookie: phone.cookie },
      },
    );
    expect(out.status).toBe(200);
    expect((await phone.client.get('/api/v1/auth/me')).status).toBe(401); // the session that logged out is dead
    expect((await laptop.client.get('/api/v1/auth/me')).status).toBe(200); // the other one is not
    await new Promise((r) => setTimeout(r, 300));
    expect(watching.socket.connected).toBe(true);
  });

  it('logging out cuts the user’s open sockets on both api copies', async () => {
    const w = await world();
    const open = [a, b].map((api) => {
      const s = connectSocket(api.url, { token: w.agent.accessToken });
      sockets.push(s);
      return s;
    });
    await Promise.all(open.map((s) => s.connected()));
    const out = await client({ baseUrl: a.url }).post(
      '/api/v1/auth/logout',
      {},
      {
        headers: { cookie: w.agent.cookie },
      },
    );
    expect(out.status).toBe(200);
    const end = Date.now() + 5000;
    while (Date.now() < end && open.some((s) => s.socket.connected))
      await new Promise((r) => setTimeout(r, 50));
    expect(open.map((s) => s.socket.connected)).toEqual([false, false]);
  });
});
