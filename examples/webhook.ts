/**
 * Runs a whole conversation against a local webhook: fragmented messages, a
 * redelivered one, and a human stepping in. No API keys, no accounts.
 *
 *   npm run example
 */
import { createServer } from 'node:http'
import { createRuntime, memoryStore } from '../src/index.js'

const runtime = createRuntime({
  store: memoryStore(),
  quietMs: 1_000,
  maxWaitMs: 5_000,
  takeoverTtlMs: 3_000,
})

runtime.on('turn', (turn) => {
  const text = turn.messages.map((m) => m.text).join(' ')
  console.log(`\n[turn] ${turn.conversationId} (new session: ${turn.isNewSession})`)
  console.log(`       "${text}"`)
  console.log(
    `       -> this is where you would call your LLM, once, with ${turn.messages.length} message(s)`,
  )
})

runtime.on('drop', (drop) => {
  console.log(`[drop] ${drop.messageId} (${drop.reason})`)
})

runtime.on('error', (error) => {
  console.error('[error]', error)
})

const server = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const payload = JSON.parse(body) as {
      kind: 'message' | 'takeover' | 'release'
      conversationId: string
      messageId?: string
      text?: string
    }

    const done =
      payload.kind === 'message'
        ? runtime.ingest({
            conversationId: payload.conversationId,
            messageId: payload.messageId!,
            text: payload.text!,
          })
        : payload.kind === 'takeover'
          ? runtime.takeover({ conversationId: payload.conversationId })
          : runtime.release({ conversationId: payload.conversationId })

    void done.then(() => {
      response.writeHead(200).end('ok')
    })
  })
})

const port = 3999
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function post(payload: Record<string, unknown>): Promise<void> {
  await fetch(`http://localhost:${port}/webhook`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

server.listen(port, async () => {
  const conversationId = '5573999999999'

  console.log('--- fragmented burst: four balloons, one turn ---')
  await post({ kind: 'message', conversationId, messageId: 'm1', text: 'hi' })
  await wait(300)
  await post({ kind: 'message', conversationId, messageId: 'm2', text: 'i wanted to ask' })
  await wait(300)
  await post({ kind: 'message', conversationId, messageId: 'm3', text: 'about the flat' })
  await wait(200)
  await post({ kind: 'message', conversationId, messageId: 'm4', text: 'the one downtown' })

  console.log('--- the gateway redelivers m4 ---')
  await post({ kind: 'message', conversationId, messageId: 'm4', text: 'the one downtown' })

  await wait(1_500)

  console.log('\n--- a human takes over, the bot goes quiet ---')
  await post({ kind: 'takeover', conversationId })
  await post({ kind: 'message', conversationId, messageId: 'm5', text: 'and the price?' })
  await wait(1_500)

  console.log('\n--- the human releases the conversation ---')
  await post({ kind: 'release', conversationId })
  await post({ kind: 'message', conversationId, messageId: 'm6', text: 'are you still there?' })
  await wait(1_500)

  await runtime.stop()
  server.close()
})
