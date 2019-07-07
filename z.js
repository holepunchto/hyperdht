const dht = require('dht-rpc')
const crypto = require('crypto')

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}

const node = dht({ ephemeral: true })

const value = 'hello'

node.update('values', sha256(value), value, function (err, res) {
  if (err) throw err
  console.log('Inserted', sha256(value).toString('hex'))
})
