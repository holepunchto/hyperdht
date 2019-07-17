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
  const keypair = nodes[4].mutable.keypair()
  let seq = 0
  nodes[4].mutable.put(Buffer.from('hello :)'), { keypair, seq }, (err, { key }) => {
    if (err) throw err
    nodes[9].mutable.get(key, { seq }, (err, { value }) => {
      if (err) throw err
      console.log(value.toString())

      seq += 1 // seq must be incremented when updating immutable data

      nodes[4].mutable.put(
        Buffer.from('goodbye :D'),
        { keypair, seq },
        (err, { key }) => {
          if (err) throw err
          nodes[0].mutable.get(key, { seq }, (err, { value }) => {
            if (err) throw err
            console.log(value.toString())
            destroy() // allow process to close
          })
        }
      )
    })
  })
}

function destroy () {
  bootstrap.destroy()
  nodes.forEach((node) => node.destroy())
}
