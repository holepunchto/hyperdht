const dht = require('./')
const crypto = require('crypto')

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
