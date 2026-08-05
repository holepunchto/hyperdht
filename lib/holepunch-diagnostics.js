const enabled = !!(
  globalThis.process &&
  globalThis.process.env &&
  globalThis.process.env.HYPERDHT_DEBUG === '1'
)
let sequence = 0

module.exports = function diagnostic(role, event, details = {}) {
  if (!enabled) return

  console.error(
    '[hyperdht-holepunch] ' +
      JSON.stringify({ time: Date.now(), sequence: ++sequence, role, event, ...details })
  )
}
