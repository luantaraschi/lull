/*
  The time strip.

  Everything the instrument draws against a clock lives here: the marks, the
  deadline, the now line and the ruler under them. It holds no conversation
  state. Marks arrive as data and a deadline arrives as a timestamp; this file
  decides only where on the window each of them lands.
*/

/* The window the strip shows. The headroom is 4s rather than 2s because the
   deadline sits quietMs ahead of the last message, and a marker drawn past the
   right edge is a marker nobody can read. */
const PAST_MS = 18_000
const AHEAD_MS = 4_000
const SPAN_MS = PAST_MS + AHEAD_MS

export function createStrip({ root, ruler, nowLine, reducedMotion }) {
  /* Nodes are kept and moved rather than rebuilt. Recreating them every frame
     would restart the turn block's animation sixty times a second. */
  const nodes = new Map()
  const deadlineNode = document.createElement('div')
  deadlineNode.className = 'strip__deadline'

  let marks = []
  let markId = 0
  let deadlineAt = null
  let lastRulerSecond = null

  function position(at, now) {
    return ((at - (now - PAST_MS)) / SPAN_MS) * 100
  }

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
    root.append(node)
    nodes.set(mark.id, node)
    return node
  }

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
      if (!deadlineNode.isConnected) root.append(deadlineNode)
      deadlineNode.style.left = `${position(deadlineAt, now)}%`
    }

    nowLine.style.left = `${position(now, now)}%`
    drawRuler(now)
  }

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

  /* One frame loop keeps the marks, the deadline and the now line on the same
     clock. Under reduced motion the strip still updates, once per event,
     because the driver calls draw() after every dispatch. */
  if (!reducedMotion.matches) requestAnimationFrame(loop)

  return {
    draw,

    /** A message, a drop or an emitted turn, placed at the time it happened. */
    mark(kind, at, extra) {
      marks.push({ id: (markId += 1), kind, at, ...extra })
    },

    setDeadline(at) {
      deadlineAt = at
    },

    setPaused(paused) {
      root.classList.toggle('strip--paused', paused)
    },

    clear() {
      for (const node of nodes.values()) node.remove()
      nodes.clear()
      deadlineNode.remove()
      marks = []
      deadlineAt = null
    },
  }
}
