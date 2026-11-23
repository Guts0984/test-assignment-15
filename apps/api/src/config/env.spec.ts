import { afterEach, describe, expect, it, vi } from 'vitest';

const valid: Record<string, string> = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
  INBOUND_WEBHOOK_SECRET: 'y'.repeat(16),
  SEED_STAFF_PASSWORD: 'Passw0rd-demo!',
};

const load = async (): Promise<typeof import('./env')> => {
  vi.resetModules();
  return import('./env');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('env', () => {
  it('loads a valid environment into a frozen object with defaults', async () => {
    for (const [k, v] of Object.entries(valid)) vi.stubEnv(k, v);
    const { env } = await load();
    expect(Object.isFrozen(env)).toBe(true);
    expect(env.NODE_ENV).toBeDefined();
  });

  it('exits with a readable message naming the missing secret', async () => {
    for (const [k, v] of Object.entries(valid)) vi.stubEnv(k, v);
    const missing = Object.keys(valid)[0] as string;
    vi.stubEnv(missing, '');
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(load()).rejects.toThrow('exit');
    expect(String(write.mock.calls[0]?.[0])).toContain(missing);
  });
});
