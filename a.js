
const dht = require('dht-rpc')
const crypto = require('crypto')
function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}

const node = dht({ ephemeral: true })

node.query('values', Buffer.from(hexFromAbove, 'hex'))
  .on('data', function (data) {
    if (data.value && sha256(data.value).toString('hex') === hexFromAbove) {
      // We found the value! Destroy the query stream as there is no need to continue.
      console.log(val, '-->', data.value.toString())
      this.destroy()
    }
  })
  .on('end', function () {
    console.log('(query finished)')
  })
