const tape = require('tape')
const HyperDHT = require('../../')

module.exports = { test, swarm, destroy }

function destroy (...nodes) {
  for (const node of nodes) {
    if (Array.isArray(node)) destroy(...node)
    else node.destroy()
  }
}

async function swarm (bootstrap, n = 32) {
  const nodes = []
  while (nodes.length < n) {
    const node = new HyperDHT({ bootstrap, ephemeral: false })
    await node.ready()
    nodes.push(node)
  }
  return nodes
}

async function test (name, fn) {
  tape(name, async function (t) {
    const bootstrappers = []
    while (bootstrappers.length < 3) {
      bootstrappers.push(new HyperDHT({ ephemeral: true, bootstrap: [] }))
    }

    const bootstrap = []
    for (const node of bootstrappers) {
      await node.bind(0)
      bootstrap.push({ host: '127.0.0.1', port: node.address().port })
    }

    await fn(bootstrap, t)

    destroy(bootstrappers)
  })
}
