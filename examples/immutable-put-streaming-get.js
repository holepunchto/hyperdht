'use strict'
const dht = require('..')

const bootstrap = dht({ ephemeral: true })

bootstrap.listen(10001)

// create 10 nodes
let n = 10
const nodes = Array.from(Array(n)).map(() => dht({
  bootstrap: [
    'localhost:10001'
  ]
}).once('listening', ready))

function ready () {
  if (--n) return // when n is 0 all nodes are up
  // select any node a put a value
  nodes[4].immutable.put(Buffer.from('hello :)'), (err, key) => {
    if (err) throw err
    // select any other node and get it
    nodes[9].immutable.get(key)
      .on('data', (value) => {
        console.log('got value: ', value.toString())
      })
      .on('end', destroy)
  })
}

function destroy () {
  bootstrap.destroy()
  nodes.forEach((node) => node.destroy())
}
