/*
  The instrument on the landing page.

  It drives the real reducer, bundled from src/core at deploy time, with the
  same facade shape the library ships: effects come back as data, and this file
  is the only thing here that owns a timer or reads a clock. The two views it
  writes to, the conversation and the strip, are handed text and numbers and
  decide nothing for themselves.
*/
import { deadline, initialState, reduce } from './vendor/index.js'
import { createChat } from './chat.js'
import { createStrip } from './strip.js'

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

/* A channel reports composing on a cadence rather than per keystroke, so the
   page throttles the same way a gateway would before the webhook is sent. The
   chip stays lit a little longer than the gap, or it would blink between two
   words. */
const TYPING_EVERY_MS = 900
const TYPING_LIT_MS = 1_500

/* The countdown carries one decimal because it is the number the whole page is
   about: at one second of resolution you cannot watch a keystroke push it back,
   which is the thing worth watching. */
const WAIT_TICK_MS = 100

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

const log = document.getElementById('log')
const composer = document.getElementById('composer')
const input = document.getElementById('input')
const takeoverButton = document.getElementById('takeover')
const redeliverButton = document.getElementById('redeliver')
const resetButton = document.getElementById('reset')
const countMessages = document.getElementById('count-messages')
const countTurns = document.getElementById('count-turns')
const countSaved = document.getElementById('count-saved')

const strip = createStrip({
  root: document.getElementById('strip'),
  ruler: document.getElementById('ruler'),
  nowLine: document.getElementById('now'),
  reducedMotion,
})

const chat = createChat({
  thread: document.getElementById('thread'),
  typing: document.getElementById('typing'),
  stateChip: document.getElementById('chat-state'),
  reducedMotion,
})

let state = initialState('demo')
let timer = null
let deadlineAt = null
/* Webhooks delivered, which is not the same as messages minted: a redelivery
   is one more of the first and none of the second. */
let received = 0
let issued = 0
let turns = 0
let paused = false
let last = null
let typingLit = false
let typingTimer = null
let typingSentAt = 0

function write(kind, detail) {
  log.querySelector('.log__empty')?.remove()
  const line = document.createElement('li')
  const name = document.createElement(kind === 'emitTurn' ? 'em' : 'b')
  name.textContent = kind
  // The detail carries whatever the visitor typed, so it goes in as text.
  line.append(name, ` ${detail}`)
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
  strip.draw()
  tickWait()
  return effects
}

function run(effect) {
  if (effect.type === 'schedule') {
    clearTimeout(timer)
    deadlineAt = effect.at
    strip.setDeadline(effect.at)
    timer = setTimeout(
      () => dispatch({ type: 'tick', at: Date.now() }),
      Math.max(0, effect.at - Date.now()),
    )
    write('schedule', `at +${((effect.at - Date.now()) / 1000).toFixed(1)}s`)
    return
  }

  if (effect.type === 'cancel') {
    clearTimeout(timer)
    deadlineAt = null
    strip.setDeadline(null)
    write('cancel', 'pending turn dropped')
    return
  }

  if (effect.type === 'drop') {
    strip.mark('dropped', Date.now())
    chat.drop(effect.messageId, effect.reason)
    write('drop', `${effect.messageId} (${effect.reason})`)
    return
  }

  if (effect.type === 'emitTurn') {
    deadlineAt = null
    strip.setDeadline(null)
    turns += 1
    const text = effect.messages.map((message) => message.text).join(' ')
    strip.mark('turn', Date.now(), { from: effect.messages[0].at, text })
    chat.close({ text, count: effect.messages.length, isNewSession: effect.isNewSession })
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
  setCounter(countMessages, received)
  setCounter(countTurns, turns)
  // Buffered messages have not been avoided yet, they are still waiting. Only
  // messages the reducer has resolved into a turn or a drop count here, so the
  // figure never claims a saving the run has not made.
  const resolved = received - state.buffer.length
  setCounter(
    countSaved,
    resolved === 0 ? 0 : Math.round(((resolved - turns) / resolved) * 100),
    '%',
  )
  strip.setPaused(paused)
  chat.setPaused(paused)
  takeoverButton.setAttribute('aria-pressed', String(paused))
  takeoverButton.textContent = paused ? 'Human releases it' : 'Human takes over'
  redeliverButton.disabled = last === null
}

function tickWait() {
  if (deadlineAt === null || state.buffer.length === 0) {
    chat.setWait(null)
    if (typingLit) chat.setTyping('idle')
    return
  }

  const now = Date.now()
  const remaining = Math.max(0, deadlineAt - now)

  /* Which of the two rules is closing this turn is not something the page
     works out for itself. It asks the library the hypothetical instead: if the
     person were still typing at the very last moment, would the deadline move?
     Where it would not, the cap is what they are waiting on and the label says
     so. The hypothetical is put at the deadline rather than at now, because a
     tick landing in the same millisecond as a keystroke would otherwise read
     as a deadline that cannot move, which is the opposite of what happened. */
  const held = deadline({ ...state, lastTypingAt: deadlineAt }, POLICY)
  const label = held <= deadlineAt ? 'maxWaitMs cap' : 'waiting for silence'

  // Not the closing rule, only the moment it last restarted from.
  const from = Math.max(state.lastMessageAt, state.lastTypingAt ?? 0)
  const span = Math.max(deadlineAt - from, 1)

  chat.setWait(label, remaining, Math.min(Math.max(remaining / span, 0), 1))
  if (typingLit) chat.setTyping('held')
}

function ingest(id, text) {
  received += 1
  last = { id, text }
  chat.add(id, text)

  const at = Date.now()
  const effects = dispatch({ type: 'message', id, text, at })
  // A dropped message draws its own mark from run(). Drawing one here as well
  // would show the strip accepting work it refused.
  if (!effects.some((effect) => effect.type === 'drop')) strip.mark('message', at)
  strip.draw()
}

composer.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (text === '') return
  input.value = ''
  issued += 1
  ingest(`m${issued}`, text)
})

input.addEventListener('input', () => {
  const now = Date.now()
  typingLit = true
  chat.setTyping(state.buffer.length === 0 ? 'idle' : 'held')
  clearTimeout(typingTimer)
  typingTimer = setTimeout(() => {
    typingLit = false
    chat.setTyping(null)
  }, TYPING_LIT_MS)

  if (now - typingSentAt < TYPING_EVERY_MS) return
  typingSentAt = now
  dispatch({ type: 'typing', at: now })
})

/* The same id arriving twice, which is what a gateway retry looks like from
   here: one more webhook received and no new message. */
redeliverButton.addEventListener('click', () => {
  if (last === null) return
  ingest(last.id, last.text)
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
  strip.draw()
})

resetButton.addEventListener('click', () => {
  clearTimeout(timer)
  clearTimeout(typingTimer)
  state = initialState('demo')
  strip.clear()
  chat.clear()
  chat.setTyping(null)
  deadlineAt = null
  received = 0
  issued = 0
  turns = 0
  paused = false
  last = null
  typingLit = false
  typingSentAt = 0
  log.innerHTML =
    '<li class="log__empty">Nothing has run yet. Send a message and the effects the reducer returns appear here.</li>'
  render()
  strip.draw()
})

chat.setTyping(null)
render()
strip.draw()
setInterval(tickWait, WAIT_TICK_MS)
