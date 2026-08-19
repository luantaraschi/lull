/*
  Renders scripts/banner.html into the transparent PNGs used by README.

  It drives a Chrome over the DevTools protocol and needs one running with a
  debugging port:

    chrome --remote-debugging-port=9222 --user-data-dir=/tmp/shot about:blank
    node scripts/shoot-banner.js
*/

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://127.0.0.1:9222'
const WIDTH = 1280
const HEIGHT = 280
const SCALE = 1

const shots = [
  { hash: '', file: 'lull-wordmark-light.png' },
  { hash: '#dark', file: 'lull-wordmark-dark.png' },
]

async function pageTarget() {
  const response = await fetch(`${ENDPOINT}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('no page target: start Chrome with --remote-debugging-port=9222')
  return page
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
}

let nextId = 0

function send(socket, method, params) {
  const id = (nextId += 1)
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
    socket.addEventListener('message', onMessage)
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..')
  const source = pathToFileURL(path.join(root, 'scripts', 'banner.html')).href
  const out = path.join(root, 'assets')
  fs.mkdirSync(out, { recursive: true })

  const page = await pageTarget()
  const socket = await connect(page.webSocketDebuggerUrl)

  await send(socket, 'Page.enable', {})
  await send(socket, 'Emulation.setDefaultBackgroundColorOverride', {
    color: { r: 0, g: 0, b: 0, a: 0 },
  })
  await send(socket, 'Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: SCALE,
    mobile: false,
  })

  for (const shot of shots) {
    await send(socket, 'Page.navigate', { url: 'about:blank' })
    await send(socket, 'Page.navigate', { url: `${source}${shot.hash}` })

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      const ready = await send(socket, 'Runtime.evaluate', {
        expression:
          'document.fonts.status === "loaded" && document.fonts.check("500 176px \'IBM Plex Mono\'")',
        returnByValue: true,
      })
      if (ready.result.value === true) break
    }

    /* An explicit region rather than whatever the viewport happens to be. The
       window behind this is smaller than the card, and without a clip the
       compositor tiles its surface into the shot. */
    const image = await send(socket, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    })
    const file = path.join(out, shot.file)
    fs.writeFileSync(file, Buffer.from(image.data, 'base64'))
    console.log(`wrote ${path.relative(root, file)} at ${WIDTH * SCALE}x${HEIGHT * SCALE}`)
  }

  await send(socket, 'Emulation.setDefaultBackgroundColorOverride', {})
  await send(socket, 'Emulation.clearDeviceMetricsOverride', {})
  socket.close()
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
