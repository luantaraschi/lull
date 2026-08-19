/*
  The three numbers the instrument runs under.

  They are faders rather than fields because the interesting thing about
  quietMs is not what it reads, it is what the deadline does while you move it.
  The bounds live on the inputs in the markup, so the page declares them once,
  and the top of each range is what the strip can still draw.

  The two values with no fader, takeoverTtlMs and dedupeWindow, arrive as fixed
  and are folded into everything this file hands back, so a Policy is built in
  one place rather than assembled by whoever needs one.

  This file paints and reports. It owns no timer, and it does not decide what a
  change means to a turn already in flight.
*/

export function createPolicy({ fixed, onChange }) {
  const inputs = [...document.querySelectorAll('[data-policy]')]
  const policy = {}

  function paint(input) {
    const min = Number(input.min)
    const max = Number(input.max)
    // The track is drawn from this, so the part already spent reads as spent.
    input.style.setProperty('--fill', `${((Number(input.value) - min) / (max - min)) * 100}%`)
    document.getElementById(`${input.id}-value`).textContent = `${input.value} ms`
  }

  for (const input of inputs) {
    policy[input.dataset.policy] = Number(input.value)
    paint(input)

    input.addEventListener('input', () => {
      policy[input.dataset.policy] = Number(input.value)
      paint(input)
      onChange({ ...fixed, ...policy })
    })
  }

  document.getElementById('policy-restore').addEventListener('click', () => {
    for (const input of inputs) {
      input.value = input.defaultValue
      policy[input.dataset.policy] = Number(input.defaultValue)
      paint(input)
    }
    onChange({ ...fixed, ...policy })
  })

  return { ...fixed, ...policy }
}
