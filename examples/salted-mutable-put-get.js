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
  const salt = nodes[4].mutable.salt()
  nodes[4].mutable.put(Buffer.from('hello :)'), { keypair, salt }, (err, { key }) => {
    if (err) throw err
    nodes[9].mutable.get(key, { salt }, (err, { value }) => {
      if (err) throw err
      console.log(value.toString())
      const differentSalt = nodes[4].mutable.salt()
      nodes[4].mutable.put(
        Buffer.from('goodbye :D'),
        { keypair, salt: differentSalt },
        (err, { key }) => {
          if (err) throw err
          nodes[0].mutable.get(key, { salt }, (err, { value }) => {
            if (err) throw err
            // be "hello :)" because we're using the first salt
            console.log(value.toString())
            nodes[0].mutable.get(key, { salt: differentSalt }, (err, { value }) => {
              if (err) throw err
              console.log(value.toString())
              destroy()
            })
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
