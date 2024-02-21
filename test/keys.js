const test = require('brittle')
const DHT = require('../')

test('incorrect key', t => {
  t.plan(1)

  const node = new DHT()
  const buf = Buffer.from('not-a-correct-key')
  try {
    node.connect(buf)
  } catch (err) {
    t.is(err.message, 'Not a valid public key')
    node.destroy()
  }
})
