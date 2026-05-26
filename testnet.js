const tmp = require('test-tmp')
const DHT = require('.')

module.exports = async function createTestnet(size = 10, opts = {}) {
  const swarm = []
  const teardown =
    typeof opts === 'function' ? opts : opts.teardown ? opts.teardown.bind(opts) : noop
  const host = opts.host || '127.0.0.1'
  const port = opts.port || 0
  const bootstrap = opts.bootstrap ? [...opts.bootstrap] : []
  const bindHost = host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0'
  const dbPath = opts.dbPath || null

  if (size === 0) return new Testnet(swarm)

  const first = new DHT({
    ephemeral: false,
    firewalled: false,
    bootstrap,
    port,
    host: bindHost,
    dbPath
  })

  await first.fullyBootstrapped()

  if (bootstrap.length === 0) bootstrap.push({ host, port: first.address().port })

  swarm.push(first)

  while (swarm.length < size) {
    const node = new DHT({
      ephemeral: false,
      firewalled: false,
      bootstrap,
      host: bindHost,
      dbPath
    })

    await node.fullyBootstrapped()
    swarm.push(node)
  }

  const testnet = new Testnet(swarm, bootstrap)

  teardown(() => testnet.destroy(), { order: Infinity })

  return testnet
}

class Testnet {
  constructor(nodes, bootstrap = []) {
    this.nodes = nodes
    this.bootstrap = bootstrap
  }

  async createNode(t, opts = {}) {
    const dbPath = await tmp(t)
    const node = new DHT({
      ephemeral: true,
      bootstrap: this.bootstrap,
      host: '127.0.0.1',
      ...opts,
      dbPath
    })

    this.nodes.push(node)

    return node
  }

  async destroy() {
    for (const node of this.nodes) {
      for (const server of node.listening) await server.close()
    }

    for (let i = this.nodes.length - 1; i >= 0; i--) {
      await this.nodes[i].destroy()
    }
  }

  [Symbol.iterator]() {
    return this.nodes[Symbol.iterator]()
  }
}

function noop() {}
