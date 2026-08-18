/*
  The instrument on the landing page.

  It drives the real reducer, bundled from src/core at deploy time, with the
  same facade shape the library ships: effects come back as data, and this file
  is the only thing here that owns a timer or reads a clock.
*/
import { initialState, reduce } from './vendor/index.js'

const POLICY = {
  quietMs: 2_500,
  maxWaitMs: 15_000,
  sessionTtlMs: 1_800_000,
  // The library default is 900000. Eight seconds is the one value this page
  // changes, so a visitor can watch a takeover lapse without waiting a quarter
  // of an hour. The header says so.
  takeoverTtlMs: 8_000,
  dedupeWindow: 200,
}

/* The window the strip shows. The headroom is 4s rather than 2s because the
   deadline sits quietMs ahead of the last message, and a marker drawn past the
   right edge is a marker nobody can read. */
const PAST_MS = 18_000
const AHEAD_MS = 4_000
const SPAN_MS = PAST_MS + AHEAD_MS

const FRAGMENTS = [
  'hi',
  'i wanted to ask',
  'about the flat',
  'the one downtown',
  'is it still available',
  'and the price',
  'can i visit tomorrow',
  'morning would be better',
]

const strip = document.getElementById('strip')
const ruler = document.getElementById('ruler')
const nowLine = document.getElementById('now')
const log = document.getElementById('log')
const sendButton = document.getElementById('send')
const takeoverButton = document.getElementById('takeover')
const resetButton = document.getElementById('reset')
const countMessages = document.getElementById('count-messages')
const countTurns = document.getElementById('count-turns')
const countSaved = document.getElementById('count-saved')

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

let state = initialState('demo')
let timer = null
let sent = 0
let turns = 0
let paused = false

/** Marks drawn on the strip: messages, drops and emitted turns. */
let marks = []
let deadlineAt = null
let markId = 0

function position(at, now) {
  return ((at - (now - PAST_MS)) / SPAN_MS) * 100
}

function write(kind, text) {
  log.querySelector('.log__empty')?.remove()
  const line = document.createElement('li')
  line.innerHTML = `<b>${kind}</b> ${text}`
  if (kind === 'emitTurn') line.innerHTML = `<em>${kind}</em> ${text}`
  log.prepend(line)
  while (log.children.length > 40) log.lastElementChild.remove()
}

function dispatch(event) {
  const [next, effects] = reduce(state, event, POLICY)
  state = next
  for (const effect of effects) run(effect)
  render()
  // Every event redraws. Without this the strip would only update inside the
  // animation frame loop, and readers who asked for reduced motion, where that
  // loop never starts, would never see a turn appear.
  draw()
}

function run(effect) {
  if (effect.type === 'schedule') {
    clearTimeout(timer)
    deadlineAt = effect.at
    timer = setTimeout(() => dispatch({ type: 'tick', at: Date.now() }), Math.max(0, effect.at - Date.now()))
    write('schedule', `at +${((effect.at - Date.now()) / 1000).toFixed(1)}s`)
    return
  }

  if (effect.type === 'cancel') {
    clearTimeout(timer)
    deadlineAt = null
    write('cancel', 'pending turn dropped')
    return
  }

  if (effect.type === 'drop') {
    marks.push({ id: (markId += 1), kind: 'dropped', at: Date.now() })
    write('drop', `${effect.messageId} (${effect.reason})`)
    return
  }

  if (effect.type === 'emitTurn') {
    deadlineAt = null
    turns += 1
    const text = effect.messages.map((message) => message.text).join(' ')
    marks.push({
      id: (markId += 1),
      kind: 'turn',
      at: Date.now(),
      from: effect.messages[0].at,
      text,
    })
    write('emitTurn', `${effect.messages.length} message(s): "${text}"`)
  }
}

/* Counters count rather than swap. A number that jumps from 0 to 75 reads as a
   different number appearing; one that runs there reads as the same number
   moving, which is what it is. 260ms, the same step the rest of the page uses
   for a change of state. */
const COUNT_MS = 260
const counterFrom = new WeakMap()

function setCounter(node, value, suffix = '') {
  const from = counterFrom.get(node) ?? 0
  if (from === value) return
  counterFrom.set(node, value)

  node.classList.remove('changed')
  // Reading offsetWidth restarts the animation; without it a second change
  // inside the same run would not play.
  void node.offsetWidth
  node.classList.add('changed')

  if (reducedMotion.matches) {
    node.textContent = `${value}${suffix}`
    return
  }

  const start = performance.now()
  const step = (frame) => {
    const progress = Math.min((frame - start) / COUNT_MS, 1)
    // Decelerating, so the last digits settle instead of snapping.
    const eased = 1 - Math.pow(1 - progress, 3)
    node.textContent = `${Math.round(from + (value - from) * eased)}${suffix}`
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function render() {
  setCounter(countMessages, sent)
  setCounter(countTurns, turns)
  // Buffered messages have not been avoided yet, they are still waiting. Only
  // messages the reducer has resolved into a turn or a drop count here, so the
  // figure never claims a saving the run has not made.
  const resolved = sent - state.buffer.length
  setCounter(countSaved, resolved === 0 ? 0 : Math.round(((resolved - turns) / resolved) * 100), '%')
  strip.classList.toggle('strip--paused', paused)
  takeoverButton.setAttribute('aria-pressed', String(paused))
  takeoverButton.textContent = paused ? 'Human releases it' : 'Human takes over'
}

/* Nodes are kept and moved rather than rebuilt. Recreating them every frame
   would restart the turn block's animation sixty times a second. */
const nodes = new Map()
const deadlineNode = document.createElement('div')
deadlineNode.className = 'strip__deadline'

function nodeFor(mark) {
  const existing = nodes.get(mark.id)
  if (existing !== undefined) return existing

  const node = document.createElement('div')
  if (mark.kind === 'turn') {
    node.className = 'strip__turn'
    node.textContent = mark.text
  } else {
    node.className = mark.kind === 'dropped' ? 'strip__mark strip__mark--dropped' : 'strip__mark'
  }
  strip.append(node)
  nodes.set(mark.id, node)
  return node
}

/* One frame loop keeps the marks, the deadline and the now line on the same
   clock. Under reduced motion the strip still updates, once per event. */
function draw() {
  const now = Date.now()
  const cutoff = now - PAST_MS - 1_000

  for (const mark of marks) {
    if ((mark.from ?? mark.at) <= cutoff) {
      nodes.get(mark.id)?.remove()
      nodes.delete(mark.id)
    }
  }
  marks = marks.filter((mark) => (mark.from ?? mark.at) > cutoff)

  for (const mark of marks) {
    const node = nodeFor(mark)
    if (mark.kind === 'turn') {
      const left = position(mark.from, now)
      node.style.left = `${left}%`
      node.style.width = `${Math.max(position(mark.at, now) - left, 2)}%`
    } else {
      node.style.left = `${position(mark.at, now)}%`
    }
  }

  if (deadlineAt === null) {
    deadlineNode.remove()
  } else {
    if (!deadlineNode.isConnected) strip.append(deadlineNode)
    deadlineNode.style.left = `${position(deadlineAt, now)}%`
  }

  nowLine.style.left = `${position(now, now)}%`
  drawRuler(now)
}

let lastRulerSecond = null

function drawRuler(now) {
  const second = Math.floor(now / 1_000)
  if (second === lastRulerSecond) return
  lastRulerSecond = second

  const ticks = []
  // Labels start one step in from each edge, where they would be clipped.
  for (let offset = 3_000; offset < PAST_MS; offset += 3_000) {
    ticks.push(
      `<span class="strip__second" style="left:${position(now - offset, now)}%">-${offset / 1000}s</span>`,
    )
  }
  ruler.innerHTML = ticks.join('')
}

function loop() {
  draw()
  requestAnimationFrame(loop)
}

sendButton.addEventListener('click', () => {
  sent += 1
  dispatch({
    type: 'message',
    id: `m${sent}`,
    text: FRAGMENTS[(sent - 1) % FRAGMENTS.length],
    at: Date.now(),
  })
  if (!paused) marks.push({ id: (markId += 1), kind: 'message', at: Date.now() })
  draw()
})

takeoverButton.addEventListener('click', () => {
  paused = !paused
  dispatch({ type: paused ? 'takeover' : 'release', at: Date.now() })
  if (paused) {
    // A takeover lapses on its own; keep the button honest about it.
    setTimeout(() => {
      if (paused) {
        paused = false
        render()
        write('takeover', 'TTL lapsed, the bot is listening again')
      }
    }, POLICY.takeoverTtlMs)
  }
  draw()
})

resetButton.addEventListener('click', () => {
  clearTimeout(timer)
  state = initialState('demo')
  for (const node of nodes.values()) node.remove()
  nodes.clear()
  deadlineNode.remove()
  marks = []
  deadlineAt = null
  sent = 0
  turns = 0
  paused = false
  log.innerHTML = '<li class="log__empty">Nothing has run yet. Send a message and the effects the reducer returns appear here.</li>'
  render()
  draw()
})

render()
draw()
if (!reducedMotion.matches) loop()
