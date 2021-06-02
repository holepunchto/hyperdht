const DHT = require('./')

start()

async function start () {
  const s = await swarm(32)

  const node = s[2]
  const k = DHT.keyPair()

  // console.log(k)
  // const s = node.kat.createSession(k)

  // const stream = node.kat.connect(k.publicKey, k)

  const session = node.kat.listen(k)

  await session.flush()

  console.log('flushed')

  await s[1].kat.connect(k.publicKey, DHT.keyPair())

  // const stream = await node.kat.gateways(k)
  // await stream.finished()
}

async function swarm (size) {
  const bootstrap = new DHT()
  await bootstrap.bind(0)

  const nodes = [bootstrap]
  while (nodes.length < size) {
    const n = new DHT({ ephemeral: false, bootstrap: [{ host: '127.0.0.1', port: bootstrap.address().port }]})
    await n.ready()
    nodes.push(n)
  }

  return nodes
}
