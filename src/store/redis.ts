import type { ConversationState } from '../core/types.js'
import type { Store } from './types.js'

/**
 * The slice of a Redis client this store uses, in ioredis argument style.
 * Typed structurally so lull keeps zero runtime dependencies: pass an
 * ioredis instance directly, or a small shim over another client.
 */
export type RedisLike = {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: unknown[]): Promise<string | null>
  del(key: string): Promise<number>
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>
}

export type RedisStoreOptions = {
  /** Prefix for every key this store writes. Defaults to `lull:`. */
  keyPrefix?: string
  /** How long a held lock survives if the holder dies. Defaults to 10s. */
  lockTtlMs?: number
  /** How long to wait for a contended lock before giving up. Defaults to 5s. */
  acquireTimeoutMs?: number
  /** Pause between acquisition attempts. Defaults to 20ms. */
  retryDelayMs?: number
}

/**
 * Deletes the lock only if we still hold it. Without the comparison, a section
 * that outlived its own TTL would delete the lock its successor is holding.
 */
const UNLOCK = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function redisStore(client: RedisLike, options: RedisStoreOptions = {}): Store {
  const prefix = options.keyPrefix ?? 'lull:'
  const lockTtlMs = options.lockTtlMs ?? 10_000
  const acquireTimeoutMs = options.acquireTimeoutMs ?? 5_000
  const retryDelayMs = options.retryDelayMs ?? 20

  const stateKey = (conversationId: string): string => `${prefix}${conversationId}`
  const lockKey = (conversationId: string): string => `${prefix}lock:${conversationId}`

  return {
    async load(conversationId) {
      const raw = await client.get(stateKey(conversationId))
      return raw === null ? null : (JSON.parse(raw) as ConversationState)
    },

    async save(state) {
      await client.set(stateKey(state.id), JSON.stringify(state))
    },

    async delete(conversationId) {
      await client.del(stateKey(conversationId))
    },

    async withLock(conversationId, fn) {
      const key = lockKey(conversationId)
      const token = globalThis.crypto.randomUUID()
      const giveUpAt = Date.now() + acquireTimeoutMs

      for (;;) {
        const acquired = await client.set(key, token, 'PX', lockTtlMs, 'NX')
        if (acquired !== null) break
        if (Date.now() >= giveUpAt) {
          throw new Error(
            `lull: timed out acquiring the lock for conversation "${conversationId}"`,
          )
        }
        await sleep(retryDelayMs)
      }

      try {
        return await fn()
      } finally {
        await client.eval(UNLOCK, 1, key, token)
      }
    },
  }
}
