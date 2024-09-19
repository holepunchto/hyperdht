const b4a = require('b4a')
const cenc = require('compact-encoding')

function encodeUnslab (enc, m) {
  // Faster than unslab(c.encode(enc, data)) because it avoids the mem copy.
  // Makes sense to put in compact-encoding when we need it in other modules too
  const state = cenc.state()
  enc.preencode(state, m)
  state.buffer = b4a.allocUnsafeSlow(state.end)
  enc.encode(state, m)
  return state.buffer
}

module.exports = {
  encodeUnslab
}
