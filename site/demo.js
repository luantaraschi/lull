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
import { createPolicy } from './policy.js'
import { createStrip } from './strip.js'

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

/* A fader fires while it is being dragged, many times a second. A change is
   not something this file acts on either way: it feeds the reducer a tick and
   takes back whatever the reducer decides, which may be a new deadline or a
   turn that is already overdue. Spacing those ticks keeps the effect log
   readable, and the trailing one guarantees that the value the fader settles
   on is the value the reducer is left holding. */
const RESCHEDULE_EVERY_MS = 120
let rescheduledAt = 0
let rescheduleTimer = null

function repolicy(next) {
  policy = next
  if (state.buffer.length === 0) {
    tickWait()
    return
  }

  const since = Date.now() - rescheduledAt
  if (since >= RESCHEDULE_EVERY_MS) {
    rescheduledAt = Date.now()
    dispatch({ type: 'tick', at: rescheduledAt })
    return
  }

  if (rescheduleTimer !== null) return
  rescheduleTimer = setTimeout(() => {
    rescheduleTimer = null
    rescheduledAt = Date.now()
    if (state.buffer.length > 0) dispatch({ type: 'tick', at: rescheduledAt })
  }, RESCHEDULE_EVERY_MS - since)
}

/* The two the page keeps off the faders. takeoverTtlMs is 900000 in the
   library and eight seconds here, so a takeover lapses while somebody is still
   looking at it. dedupeWindow is the library default: nothing the page can do
   would move it far enough to be worth a control. */
const FIXED = { takeoverTtlMs: 8_000, dedupeWindow: 200 }

let policy = createPolicy({ fixed: FIXED, onChange: repolicy })

function write(kind, detail) {
  log.querySelector('.log__empty')?.remove()

  /* Somebody typing, or dragging a fader, produces a run of schedules. Forty
     copies of one line is not a record of what happened, it is a record with
     the interesting parts pushed off the bottom, so a run collapses into a
     single line carrying the latest deadline and how often it moved. Only
     schedules collapse: two drops in a row are two different messages. */
  const previous = log.firstElementChild
  if (kind === 'schedule' && previous?.dataset.kind === 'schedule') {
    const repeats = Number(previous.dataset.repeats ?? 1) + 1
    previous.dataset.repeats = String(repeats)
    previous.querySelector('.log__detail').textContent = ` ${detail}`
    previous.querySelector('.log__repeats').textContent = ` ×${repeats}`
    return
  }

  const line = document.createElement('li')
  line.dataset.kind = kind

  const name = document.createElement(kind === 'emitTurn' ? 'em' : 'b')
  name.textContent = kind

  // The detail carries whatever the visitor typed, so it goes in as text.
  const body = document.createElement('span')
  body.className = 'log__detail'
  body.textContent = ` ${detail}`

  const repeats = document.createElement('span')
  repeats.className = 'log__repeats'

  line.append(name, body, repeats)
  log.prepend(line)
  while (log.children.length > 40) log.lastElementChild.remove()
}

function dispatch(event) {
  const [next, effects] = reduce(state, event, policy)
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
  const held = deadline({ ...state, lastTypingAt: deadlineAt }, policy)
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
    }, policy.takeoverTtlMs)
  }
  strip.draw()
})

resetButton.addEventListener('click', () => {
  clearTimeout(timer)
  clearTimeout(typingTimer)
  clearTimeout(rescheduleTimer)
  rescheduleTimer = null
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
