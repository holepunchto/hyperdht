const dht = require('../')
const crypto = require('crypto')

// in order to bootstrap we start an
// ephemeral node with empty bootstrap array
// and then call listen on it
const bs = dht({
  ephemeral: true,
  bootstrap: []
})

bs.listen(function () {
  const { port } = bs.address()
  // represents stateful nodes in the dht
  const state = dht({
    ephemeral: false,
    bootstrap: ['127.0.0.1:' + port]
  })

  state.on('ready', () => {
    // from here this is the same as the announce-lookup example
    const node = dht({
      ephemeral: true,
      bootstrap: ['127.0.0.1:' + port]
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
            state.destroy()
            bs.destroy()
          })
        })
    })
  })
})
