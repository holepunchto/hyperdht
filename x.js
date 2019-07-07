const dht = require('dht-rpc')
const crypto = require('crypto')

// Let's create 100 dht nodes for our example.
for (var i = 0; i < 100; i++) createNode()

function createNode () {
  const node = dht({
    bootstrap: [
      'localhost:10001'
    ]
  })

  const values = new Map()

  node.command('values', {
    // When we are the closest node and someone is sending us a "store" command
    update (query, cb) {
      if (!query.value) return cb()

      // Use the hash of the value as the key
      const key = sha256(query.value).toString('hex')
      values.set(key, query.value)
      console.log('Storing', key, '-->', query.value.toString())
      cb()
    },
    // When someone is querying for a "lookup" command
    query (query, cb) {
      const value = values.get(query.target.toString('hex'))
      cb(null, value)
    }
  })
}

function sha256 (val) {
  return crypto.createHash('sha256').update(val).digest()
}
