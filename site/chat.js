/*
  The conversation view.

  It shows the same run the strip shows, from the other side: balloons going
  out, the wait that has not closed yet, and the single turn the buffered ones
  became. It owns no timer and reads no clock. The driver hands it text and
  numbers; this file decides only how they look.

  Everything the visitor types enters as a text node. It is their own page and
  their own markup, but a balloon that renders tags is a balloon that can break
  the layout it sits in.
*/

export function createChat({ thread, typing, stateChip, reducedMotion }) {
  /** The run of balloons that will merge into one turn, once it closes. */
  let group = null
  let wait = null
  let pending = []

  function scroll() {
    thread.scrollTop = thread.scrollHeight
  }

  function openGroup() {
    if (group !== null) return group
    thread.querySelector('.chat__empty')?.remove()
    group = document.createElement('li')
    group.className = 'chat__group'
    group.dataset.state = 'open'
    thread.append(group)
    return group
  }

  /* A group is sealed when nothing more can join it: either it fired as a turn
     or a takeover emptied it. The next message opens a fresh one. */
  function seal(state) {
    if (group === null) return
    group.dataset.state = state
    wait?.remove()
    wait = null
    group = null
    pending = []
  }

  return {
    add(messageId, text) {
      const node = document.createElement('div')
      node.className = 'balloon'
      node.textContent = text
      const holder = openGroup()
      holder.append(node)
      // The countdown belongs under everything it is counting for, and a
      // balloon appended after it would otherwise leave it stranded mid group.
      if (wait !== null) holder.append(wait)
      pending.push({ messageId, node })
      scroll()
    },

    /* Dropped balloons stay where they happened rather than disappearing. A
       redelivered webhook that vanished would be indistinguishable from one
       that was never sent, which is the opposite of what the page is showing. */
    drop(messageId, reason) {
      // The last match, not the first: a redelivery carries the id of a message
      // that may still be sitting in the buffer, and the copy is the one dropped.
      let index = -1
      for (let at = pending.length - 1; at >= 0; at -= 1) {
        if (pending[at].messageId === messageId) {
          index = at
          break
        }
      }
      if (index === -1) return

      const [item] = pending.splice(index, 1)
      item.node.classList.add('balloon--dropped')
      const tag = document.createElement('span')
      tag.className = 'balloon__tag'
      tag.textContent = `dropped: ${reason}`
      item.node.append(tag)

      if (pending.length === 0) seal('dropped')
      scroll()
    },

    close({ text, count, isNewSession }) {
      const turn = document.createElement('div')
      turn.className = 'chat__turn'

      const head = document.createElement('span')
      head.className = 'chat__turn-head'
      const tally = count === 1 ? 'one message' : `${count} messages`
      head.textContent = isNewSession ? `one turn, ${tally}, new session` : `one turn, ${tally}`

      const body = document.createElement('span')
      body.className = 'chat__turn-text'
      body.textContent = text
      turn.append(head, body)

      const closing = openGroup()
      const before = closing.getBoundingClientRect().height

      for (const item of pending) item.node.remove()
      pending = []
      wait?.remove()
      wait = null
      closing.append(turn)

      /* The balloons leave and the block arrives in the same beat, so the
         group is held at its old height for one frame and then let down to the
         new one. Without that the thread jumps and the merge reads as a cut. */
      const after = closing.getBoundingClientRect().height
      if (!reducedMotion.matches && before !== after) {
        closing.style.height = `${before}px`
        void closing.offsetHeight
        closing.style.height = `${after}px`
        closing.addEventListener(
          'transitionend',
          () => {
            closing.style.height = ''
          },
          { once: true },
        )
      }

      group = closing
      seal('closed')
      scroll()
    },

    /** The countdown under the open group. Null while nothing is buffered. */
    setWait(label, remainingMs, left) {
      if (group === null || label === null) {
        wait?.remove()
        wait = null
        return
      }

      if (wait === null) {
        wait = document.createElement('div')
        wait.className = 'chat__wait'
        wait.innerHTML =
          '<span class="chat__wait-label"></span><span class="chat__wait-left"></span><span class="chat__wait-bar"><i></i></span>'
        group.append(wait)
        scroll()
      }

      wait.querySelector('.chat__wait-label').textContent = label
      wait.querySelector('.chat__wait-left').textContent = `${(remainingMs / 1000).toFixed(1)}s`
      wait.querySelector('.chat__wait-bar i').style.transform = `scaleX(${left})`
    },

    /* Three dots would be the second expressive device on a page that has
       decided to have one. The chip says it in the same voice as the rest. */
    setTyping(mode) {
      typing.hidden = mode === null
      if (mode === null) return
      typing.textContent =
        mode === 'held'
          ? 'typing event received, turn held open'
          : 'typing event received, nothing buffered to hold'
    },

    setPaused(paused) {
      stateChip.textContent = paused ? 'human in control' : 'bot listening'
      stateChip.dataset.state = paused ? 'paused' : 'listening'
    },

    clear() {
      thread.innerHTML =
        '<li class="chat__empty">Type a few short messages, the way somebody types on WhatsApp. lull buffers them and hands your agent one turn.</li>'
      group = null
      wait = null
      pending = []
    },
  }
}
