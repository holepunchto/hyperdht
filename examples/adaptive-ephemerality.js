const dht = require('../')
const crypto = require('crypto')

// UNCOMMENT THIS IF YOU DON'T WANT TO WAIT TWO MINUTES
// global.setTimeout = setImmediate

// in order to bootstrap we start an
// ephemeral node and call listen on it
const bs = dht({
  ephemeral: true,
  bootstrap: []
})

bs.listen(function () {
  const { port } = bs.address()

  // this node will not start out as stateful,
  // but will join the dht after 2 mins
  const state = dht({
    ephemeral: true,
    adaptive: true,
    bootstrap: ['127.0.0.1:' + port]
  })

  state.on('ready', () => {
    // from here this is the same as the announce-lookup example
    const node = dht({
      ephemeral: true,
      bootstrap: ['127.0.0.1:' + port]
    })

    const topic = crypto.randomBytes(32)

    node.announce(topic, { port: 12345 }, function (err) {
      console.log('first announce attempt failed as expected: ', err.message)
      console.log('waiting 2 mins for the adaptive node to join the dht')
      setTimeout(() => {
        node.announce(topic, { port: 12345 }, function (err) {
          if (err) throw err
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
      }, 1000 * 60 * 2)
    })
  })
})
