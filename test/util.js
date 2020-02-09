'use strict'
const { once } = require('nonsynchronous')

const dht = require('../')

async function dhtBootstrap ({ ephemeral = false, size = 1 } = {}) {
  const nodes = []
  let firstPort = 0
  while (size--) {
    const node = dht({ bootstrap: [], ephemeral })
    node.listen()
    await once(node, 'listening')
    nodes.push(node)
  }
  const bootstrap = nodes.map((node) => {
    const { port } = node.address()
    firstPort = firstPort || port
    return `127.0.0.1:${port}`
  })
  const closeDht = () => {
    for (const node of nodes) {
      node.destroy()
    }
  }
  return { port: firstPort, bootstrap, closeDht }
}

module.exports = { dhtBootstrap }
