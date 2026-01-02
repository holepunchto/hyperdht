const DHT = require('hyperdht')
const vocabulary = require('./vocabulary')
const { SimHash } = require('simhash-vocabulary')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const { spawn } = require('bare-subprocess')
const fs = require('bare-fs')
const process = require('bare-process')
const Hyperbee = require('hyperbee')

const beeKey = process.argv[2]
const searchTokens = process.argv.slice(3)

async function main() {
  const node = new DHT({
    ephemeral: true,
    host: '127.0.0.1',
    bootstrap: [{ host: '127.0.0.1', port: 49739 }],
    simhash: new SimHash(vocabulary)
  })
  const swarm = new Hyperswarm()
  const store = new Corestore('./client')
  const bee = new Hyperbee(store.get(beeKey), {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await bee.ready()

  swarm.on('connection', (conn) => {
    console.log('connection')
    store.replicate(conn)
  })

  const discovery = swarm.join(bee.discoveryKey, { client: true, server: false })
  await discovery.flushed()

  await new Promise((res) => setTimeout(res, 2000))

  const res = await node.search(['gif', ...searchTokens])

  for (const r of res) {
    const file = await bee.get(r.values[0].toString('hex'))
    console.log('Found', file.value.path, ', distance:', r.distance)
  }

  if (res.length > 0) {
    const { value: file } = await bee.get(res[0].values[0].toString('hex'))

    const drive = new Hyperdrive(store, Buffer.from(file.key, 'hex'))
    await drive.ready()
    const discovery = swarm.join(drive.discoveryKey, { client: true, server: false })
    await discovery.flushed()

    const fileData = await drive.get(file.path)
    fs.writeFileSync(`search-results/${file.path}`, fileData)

    spawn('open', [`search-results/${file.path}`])
  }
}

main()
