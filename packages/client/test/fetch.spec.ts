import { expect, test, vi } from 'vitest';
import { TriplitClient } from '../src/client/triplit-client.js';

const LOCAL_POLICIES = [
  'local-only',
  'local-first',
  'local-and-remote',
] as const;

test.each(LOCAL_POLICIES)(
  '[%s] fetch resolve if the client is offline',
  { timeout: 40 },
  async (policy) => {
    const client = new TriplitClient();
    const fetchPromise = client.fetch(client.query('Todos'), { policy });
    await expect(fetchPromise).resolves.toMatchObject([]);
  }
);

const REMOTE_POLICIES = ['remote-only', 'remote-first'] as const;

test.each(REMOTE_POLICIES)(
  '[%s] fetch throws an error if the client is offline',
  { timeout: 40 },
  async (policy) => {
    const client = new TriplitClient();
    const fetchPromise = client.fetch(client.query('Todos'), { policy });
    await expect(fetchPromise).rejects.toThrowError();
  }
);

export function pause(ms = 100) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
