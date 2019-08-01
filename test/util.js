'use strict'
const { once } = require('nonsynchronous')

const dht = require('../')

async function dhtBootstrap () {
  const node = dht()
  await once(node, 'listening')
  const { port } = node.address()
  return {
    port,
    bootstrap: [`127.0.0.1:${port}`],
    closeDht: () => node.destroy()
  }
}

module.exports = { dhtBootstrap }
