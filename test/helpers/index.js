const HyperDHT = require('../../')

module.exports = { swarm, destroy, toArray }

async function toArray (iterable) {
  const result = []
  for await (const data of iterable) result.push(data)
  return result
}

async function destroy (...nodes) {
  for (const node of nodes) {
    for (const server of node.listening) await server.close()
  }

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]

    if (Array.isArray(node)) await destroy(...node)
    else await node.destroy()
  }
}

async function swarm (t, n = 32, bootstrap = []) {
  const nodes = []
  while (nodes.length < n) {
    const node = new HyperDHT({ bootstrap, ephemeral: false })
    await node.ready()
    if (!bootstrap.length) bootstrap = [{ host: '127.0.0.1', port: node.address().port }]
    nodes.push(node)
  }
  t.teardown(() => destroy(...nodes))
  return {
    nodes,
    bootstrap,
    createNode (opts = {}) {
      const node = new HyperDHT({ bootstrap, ephemeral: true, ...opts })
      nodes.push(node)
      return node
    },
    [Symbol.iterator] () {
      return nodes[Symbol.iterator]()
    }
  }
}
