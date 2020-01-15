#!/usr/bin/env node

const dht = require('./')()
const quiet = process.argv.includes('--quiet')

console.log('node id: ' + dht.id.toString('hex'))

dht.on('ready', function () {
  console.log('dht node fully bootstrapped')
})

if (!quiet) {
  dht.on('announce', function (target, peer) {
    console.log('received announce', target, peer)
  })

  dht.on('unannounce', function (target, peer) {
    console.log('received unannounce', target, peer)
  })

  dht.on('lookup', function (target, peer) {
    console.log('received lookup', target, peer)
  })
}
