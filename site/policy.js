/*
  The policy the instrument runs under.

  The five numbers in the header are the Policy type the library takes, and
  they are editable for the reason the strip is drawn at all: a value you can
  move is a value you understand. The bounds live on the inputs in the markup
  rather than here, so the page declares them once, and the top of each range
  is what the strip can still draw.

  This file hands the driver a plain object. It never schedules anything, and
  it never decides what a change means to a turn already in flight.
*/

export function createPolicy({ onChange }) {
  const inputs = [...document.querySelectorAll('[data-policy]')]
  const policy = {}

  /* The field is as wide as the digits in it, so the line does not jump when
     2500 becomes 800. One extra character keeps the caret off the rule. */
  function size(input) {
    input.style.width = `${Math.max(input.value.length, 1) + 1}ch`
  }

  function clamp(input) {
    const parsed = Number(input.value)
    if (input.value.trim() === '' || !Number.isFinite(parsed)) return null
    return Math.min(Math.max(Math.round(parsed), Number(input.min)), Number(input.max))
  }

  for (const input of inputs) {
    policy[input.dataset.policy] = Number(input.defaultValue)
    size(input)

    /* Two listeners rather than one. Clamping on every keystroke would rewrite
       200 over the 8 of somebody on their way to 800, so a value on its way
       somewhere is taken only while it is already in range, and the field is
       corrected once the person has left it. */
    input.addEventListener('input', () => {
      size(input)
      const value = clamp(input)
      if (value === null || String(value) !== input.value.trim()) return
      policy[input.dataset.policy] = value
      onChange({ ...policy })
    })

    input.addEventListener('change', () => {
      const value = clamp(input)
      policy[input.dataset.policy] = value ?? policy[input.dataset.policy]
      input.value = String(policy[input.dataset.policy])
      size(input)
      onChange({ ...policy })
    })
  }

  document.getElementById('policy-restore').addEventListener('click', () => {
    for (const input of inputs) {
      input.value = input.defaultValue
      policy[input.dataset.policy] = Number(input.defaultValue)
      size(input)
    }
    onChange({ ...policy })
  })

  return { ...policy }
}
