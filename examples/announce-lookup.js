const dht = require('../')
const crypto = require('crypto')

// uses the public bootstrap servers, for an equivalent
// example that starts a bootstrap server and a node to hold state
// see examples/local-bootstrap.js

const node = dht({
  // just join as an ephemeral node
  // as we are shortlived
  ephemeral: true
})

const topic = crypto.randomBytes(32)

// announce a port
node.announce(topic, { port: 12345 }, function (err) {
  if (err) throw err

  // try and find it
  node.lookup(topic)
    .on('data', console.log)
    .on('end', function () {
      // unannounce it and shutdown
      node.unannounce(topic, { port: 12345 }, function () {
        node.destroy()
      })
    })
})
