#!/usr/bin/env node

const dht = require('./')()

dht.on('ready', function () {
  console.log('dht node fully bootstrapped')
})

dht.on('announce', function (target, peer) {
  console.log('received announce', target, peer)
})

dht.on('unannounce', function (target, peer) {
  console.log('received unannounce', target, peer)
})

dht.on('lookup', function (target, peer) {
  console.log('received lookup', target, peer)
})
