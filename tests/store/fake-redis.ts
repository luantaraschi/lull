import type { RedisLike } from '../../src/store/redis.js'

type Entry = { value: string; expiresAt: number | null }

/**
 * Models the handful of Redis commands redisStore uses, including NX and PX
 * semantics and the compare-and-delete unlock script. A test double, not a
 * Redis implementation: it exists so the store's logic can be exercised
 * without a server.
 */
export function fakeRedis(): RedisLike & { size(): number } {
  const data = new Map<string, Entry>()

  function live(key: string): Entry | undefined {
    const entry = data.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      data.delete(key)
      return undefined
    }
    return entry
  }

  return {
    async get(key) {
      return live(key)?.value ?? null
    },

    async set(key, value, ...args: unknown[]) {
      const flags = args.map((a) => (typeof a === 'string' ? a.toUpperCase() : a))
      const nx = flags.includes('NX')
      const pxIndex = flags.indexOf('PX')
      const px = pxIndex === -1 ? null : Number(flags[pxIndex + 1])

      if (nx && live(key) !== undefined) return null

      data.set(key, { value, expiresAt: px === null ? null : Date.now() + px })
      return 'OK'
    },

    async del(key) {
      return data.delete(key) ? 1 : 0
    },

    async eval(script, numKeys, ...args: unknown[]) {
      // The only script the store runs: delete the key if we still hold it.
      if (!script.includes('redis.call("get"')) throw new Error('unknown script')
      const key = String(args[0])
      const token = String(args[numKeys])
      if (live(key)?.value !== token) return 0
      data.delete(key)
      return 1
    },

    size() {
      return data.size
    },
  }
}
