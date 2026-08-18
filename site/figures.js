/*
  The benchmark figures count up the first time they are scrolled into view.

  The markup already carries the final numbers, so a reader with no JavaScript,
  or one who arrives with the section already on screen and scrolls past in a
  hurry, still reads the measurement. This file only takes them from zero and
  puts them back.
*/
const RUN_MS = 1100

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const figures = [...document.querySelectorAll('[data-figure]')]

function format(value, decimals) {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function count(node) {
  const target = Number(node.dataset.figure)
  const decimals = Number(node.dataset.decimals ?? 0)
  const suffix = node.dataset.suffix ?? ''
  const start = performance.now()

  const step = (frame) => {
    const progress = Math.min((frame - start) / RUN_MS, 1)
    // Decelerating hard: the figure covers most of its distance early and
    // spends the tail settling, which is what makes it read as arriving at a
    // number rather than stopping at one.
    const eased = 1 - Math.pow(1 - progress, 4)
    node.textContent = `${format(target * eased, decimals)}${suffix}`
    if (progress < 1) requestAnimationFrame(step)
  }

  requestAnimationFrame(step)
}

if (figures.length > 0 && !reducedMotion.matches && 'IntersectionObserver' in window) {
  for (const node of figures) {
    node.textContent = `${format(0, Number(node.dataset.decimals ?? 0))}${node.dataset.suffix ?? ''}`
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        // Once. A figure that re-counts every time it scrolls past turns a
        // measurement into an ornament.
        observer.unobserve(entry.target)
        entry.target.parentElement?.classList.add('counting')
        count(entry.target)
      }
    },
    { threshold: 0.9 },
  )

  for (const node of figures) observer.observe(node)
}
