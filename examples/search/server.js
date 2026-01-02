const { SimHash } = require('simhash-vocabulary')
const createTestnet = require('hyperdht/testnet')
const path = require('bare-path')
const { randomBytes } = require('bare-crypto')
const MirrorDrive = require('mirror-drive')
const Localdrive = require('localdrive')
const Hyperdrive = require('hyperdrive')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const { Transform } = require('streamx')
const vocabulary = require('./vocabulary')
const Hyperbee = require('hyperbee')

async function main() {
  const testnet = await createTestnet(10, {
    port: 49739
  })

  for (const n of testnet) {
    n._simhash = new SimHash(vocabulary)
  }

  function pushDHT(file) {
    return new Transform({
      async transform(chunk, cb) {
        const tokens = path.basename(file).replace(/\..+$/, '').split('_').filter(Boolean)

        const key = randomBytes(32)
        await testnet.nodes[0].searchableRecordPut(['gif', ...tokens], key)
        await bee.put(key.toString('hex'), {
          path: file,
          key: dst.key.toString('hex')
        })
        this.push(chunk)
        cb(null)
      }
    })
  }

  const swarm = new Hyperswarm()
  const store = new Corestore('./server')
  const bee = new Hyperbee(store.get({ name: 'lookup' }), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await bee.ready()

  swarm.on('connection', (conn) => {
    console.log('connection')
    store.replicate(conn)
  })
  const src = new Localdrive('./images')
  const dst = new Hyperdrive(store)

  const mirror = new MirrorDrive(src, dst, {
    transformers: [
      (file) => {
        return pushDHT(file)
      }
    ]
  })

  await mirror.done()

  {
    const discovery = swarm.join(bee.discoveryKey)
    await discovery.flushed()
  }

  {
    const discovery = swarm.join(dst.discoveryKey)
    await discovery.flushed()
  }

  for await (const file of dst.list('.')) {
    console.log('list', file) // => { key, value }
  }

  console.log('Serving DHT on', bee.key.toString('hex'), testnet.nodes[0].port)
}

main()
