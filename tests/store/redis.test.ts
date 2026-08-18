import { describe, expect, test } from 'vitest'
import { initialState } from '../../src/core/reduce.js'
import { redisStore } from '../../src/store/redis.js'
import { fakeRedis } from './fake-redis.js'

describe('redisStore state', () => {
  test('round-trips a conversation state through the client', async () => {
    const store = redisStore(fakeRedis())
    expect(await store.load('c1')).toBeNull()

    await store.save({ ...initialState('c1'), lastMessageAt: 42, seen: ['m1'] })
    const loaded = await store.load('c1')

    expect(loaded?.lastMessageAt).toBe(42)
    expect(loaded?.seen).toEqual(['m1'])
  })

  test('namespaces keys with the configured prefix', async () => {
    const client = fakeRedis()
    const store = redisStore(client, { keyPrefix: 'lull:test:' })

    await store.save(initialState('c1'))

    expect(await client.get('lull:test:c1')).not.toBeNull()
    expect(await client.get('c1')).toBeNull()
  })

  test('delete removes the conversation', async () => {
    const store = redisStore(fakeRedis())
    await store.save(initialState('c1'))

    await store.delete('c1')

    expect(await store.load('c1')).toBeNull()
  })
})

describe('redisStore locking', () => {
  test('serialises concurrent work on the same conversation', async () => {
    const store = redisStore(fakeRedis(), { retryDelayMs: 1 })
    await store.save(initialState('c1'))

    // Without a lock, every one of these reads the same state and ends at 1.
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.withLock('c1', async () => {
          const state = await store.load('c1')
          await new Promise((resolve) => setTimeout(resolve, 0))
          await store.save({ ...state!, lastMessageAt: state!.lastMessageAt + 1 })
        }),
      ),
    )

    expect((await store.load('c1'))?.lastMessageAt).toBe(20)
  })

  test('different conversations are not blocked by each other', async () => {
    const store = redisStore(fakeRedis(), { retryDelayMs: 1 })
    const order: string[] = []

    await Promise.all([
      store.withLock('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push('slow')
      }),
      store.withLock('fast', async () => {
        order.push('fast')
      }),
    ])

    expect(order).toEqual(['fast', 'slow'])
  })

  test('a failed critical section releases the lock', async () => {
    const store = redisStore(fakeRedis(), { retryDelayMs: 1 })

    await expect(
      store.withLock('c1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(store.withLock('c1', async () => 'ok')).resolves.toBe('ok')
  })

  test('releases no lock but its own once its TTL has lapsed', async () => {
    const client = fakeRedis()
    const store = redisStore(client, { lockTtlMs: 30, retryDelayMs: 1 })

    // A section that outlives its own lock TTL: by the time it finishes, the
    // lock it holds has expired and another worker owns the key.
    await store.withLock('c1', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      await client.set('lull:lock:c1', 'someone-else', 'PX', 5_000)
    })

    expect(await client.get('lull:lock:c1')).toBe('someone-else')
  })

  test('gives up waiting after the acquire timeout', async () => {
    const client = fakeRedis()
    const store = redisStore(client, { lockTtlMs: 5_000, acquireTimeoutMs: 30, retryDelayMs: 1 })
    await client.set('lull:lock:c1', 'held-elsewhere', 'PX', 5_000)

    await expect(store.withLock('c1', async () => 'never')).rejects.toThrow(/lock/i)
  })
})
