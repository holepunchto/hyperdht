'use strict'
const { once } = require('nonsynchronous')

const dht = require('../')

async function dhtBootstrap ({ ephemeral = true, aux = false } = {}) {
  const node = dht({ bootstrap: [], ephemeral })
  node.listen()
  await once(node, 'listening')
  const { port } = node.address()
  const bootstrap = [`127.0.0.1:${port}`]
  const peer = aux && dht({
    ephemeral: false,
    bootstrap
  })
  if (aux) await once(peer, 'listening')
  return {
    port,
    auxPort: aux && peer.address().port,
    bootstrap,
    closeDht: () => {
      node.destroy()
      if (aux) peer.destroy()
    }
  }
}

module.exports = { dhtBootstrap }
