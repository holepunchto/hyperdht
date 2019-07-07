const dht = require('..')

const bootstrap = dht({ ephemeral: true })

bootstrap.listen(10001)

// create 100 nodes
Array.from(Array(100)).map(() => dht({
  bootstrap: [
    'localhost:10001'
  ]
}))

const node = dht({
  bootstrap: [
    'localhost:10001'
  ]
})

node.put({ v: Buffer.from('hello :)') }, (err, key) => {
  if (err) throw err
  node.get({ k: key }, (err, value) => {
    if (err) throw err

    console.log(value)
  })
})
