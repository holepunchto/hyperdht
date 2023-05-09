const test = require('brittle')
const PEX = require('protomux-pex')
const DHT = require('..')
const { swarm } = require('./helpers')

test('peer exchange', async (t) => {
  const [boot] = await swarm(t)

  const bootstrap = [{ host: '127.0.0.1', port: boot.address().port }]
  const a = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const b = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })
  const c = new DHT({ bootstrap, quickFirewall: false, ephemeral: true })

  await a.ready()
  await b.ready()
  await c.ready()

  const as = a.createServer({ shareLocalAddress: false })
  await as.listen()

  t.comment('a key', as.publicKey.toString('hex'))

  const bs = b.createServer({ shareLocalAddress: false }, (stream) => {
    const pex = new PEX(stream)
    pex
      .on('want', (discoveryKey) => {
        pex.have(discoveryKey, [{ publicKey: as.publicKey }])
      })
  })
  await bs.listen()

  t.comment('b key', bs.publicKey.toString('hex'))

  {
    const lc = t.test('socket lifecycle')
    lc.plan(1)

    b.connect(as.publicKey, { localConnection: false })
      .on('error', () => {})
      .on('open', () => {
        lc.pass('b connected to a')
      })

    await lc
  }

  {
    const lc = t.test('socket lifecycle')
    lc.plan(2)

    const stream = c.connect(bs.publicKey, { localConnection: false })
      .on('error', () => {})
      .on('open', async () => {
        lc.pass('c connected to b')

        const pex = new PEX(stream)
        pex
          .on('have', (discoveryKey, capability, peers) => {
            lc.pass('b has a')
          })
          .want(Buffer.alloc(32, 'discovery key'))
      })

    await lc
  }

  await a.destroy()
  await b.destroy()
  await c.destroy()
})
