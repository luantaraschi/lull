import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createRuntime } from '../../src/runtime/runtime.js'
import { memoryStore } from '../../src/store/memory.js'
import type { Drop, Turn } from '../../src/runtime/runtime.js'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  vi.useRealTimers()
})

function setup() {
  const turns: Turn[] = []
  const drops: Drop[] = []
  const runtime = createRuntime({ store: memoryStore(), quietMs: 2_500, maxWaitMs: 15_000 })
  runtime.on('turn', (turn) => {
    turns.push(turn)
  })
  runtime.on('drop', (drop) => {
    drops.push(drop)
  })
  return { runtime, turns, drops }
}

describe('createRuntime', () => {
  test('emits one turn for a burst of fragmented messages', async () => {
    const { runtime, turns } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await vi.advanceTimersByTimeAsync(800)
    await runtime.ingest({ conversationId: 'c1', messageId: 'm2', text: 'about the flat' })
    await vi.advanceTimersByTimeAsync(600)
    await runtime.ingest({ conversationId: 'c1', messageId: 'm3', text: 'the one downtown' })

    expect(turns).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(2_500)

    expect(turns).toHaveLength(1)
    expect(turns[0]?.messages.map((m) => m.text)).toEqual([
      'hi',
      'about the flat',
      'the one downtown',
    ])
    expect(turns[0]?.isNewSession).toBe(true)

    await runtime.stop()
  })

  test('reports a redelivered message as a drop', async () => {
    const { runtime, drops } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await vi.advanceTimersByTimeAsync(2_500)

    expect(drops).toEqual([{ conversationId: 'c1', messageId: 'm1', reason: 'duplicate' }])

    await runtime.stop()
  })

  test('takeover cancels the pending turn', async () => {
    const { runtime, turns } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await runtime.takeover({ conversationId: 'c1' })
    await vi.advanceTimersByTimeAsync(10_000)

    expect(turns).toEqual([])

    await runtime.stop()
  })

  test('release lets the bot answer again', async () => {
    const { runtime, turns } = setup()

    await runtime.takeover({ conversationId: 'c1' })
    await runtime.release({ conversationId: 'c1' })
    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hello?' })
    await vi.advanceTimersByTimeAsync(2_500)

    expect(turns).toHaveLength(1)

    await runtime.stop()
  })

  test('a throwing turn handler surfaces on the error channel', async () => {
    const errors: unknown[] = []
    const runtime = createRuntime({ store: memoryStore(), quietMs: 1_000 })
    runtime.on('turn', () => {
      throw new Error('handler blew up')
    })
    runtime.on('error', (error) => {
      errors.push(error)
    })

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect((errors[0] as Error).message).toBe('handler blew up')

    await runtime.stop()
  })

  test('stop clears pending timers', async () => {
    const { runtime, turns } = setup()

    await runtime.ingest({ conversationId: 'c1', messageId: 'm1', text: 'hi' })
    await runtime.stop()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(turns).toEqual([])
  })
})
