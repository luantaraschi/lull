import { describe, expect, test } from 'vitest'
import { memoryStore } from '../../src/store/memory.js'
import { initialState } from '../../src/core/reduce.js'

describe('memoryStore', () => {
  test('round-trips a conversation state', async () => {
    const store = memoryStore()
    expect(await store.load('c1')).toBeNull()

    await store.save({ ...initialState('c1'), lastMessageAt: 42 })
    expect((await store.load('c1'))?.lastMessageAt).toBe(42)

    await store.delete('c1')
    expect(await store.load('c1')).toBeNull()
  })

  test('serialises concurrent work on the same conversation', async () => {
    const store = memoryStore()
    await store.save(initialState('c1'))

    // Without a lock, every one of these reads the same state and the count ends at 1.
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.withLock('c1', async () => {
          const state = await store.load('c1')
          await new Promise((resolve) => setTimeout(resolve, 0))
          await store.save({ ...state!, lastMessageAt: state!.lastMessageAt + 1 })
        }),
      ),
    )

    expect((await store.load('c1'))?.lastMessageAt).toBe(50)
  })

  test('different conversations are not blocked by each other', async () => {
    const store = memoryStore()
    const order: string[] = []

    await Promise.all([
      store.withLock('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        order.push('slow')
      }),
      store.withLock('fast', async () => {
        order.push('fast')
      }),
    ])

    expect(order).toEqual(['fast', 'slow'])
  })

  test('a failed critical section releases the lock', async () => {
    const store = memoryStore()

    await expect(
      store.withLock('c1', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    await expect(store.withLock('c1', async () => 'ok')).resolves.toBe('ok')
  })
})
