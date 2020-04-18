#!/usr/bin/env node

const os = require('os')
const path = require('path')
const fs = require('fs')
const dhtrpc = require('dht-rpc')

const ephemeral = !process.argv.includes('--non-ephemeral')
const idFile = path.join(os.tmpdir(), 'dht-rpc-id')
if (!fs.existsSync(idFile)) fs.writeFileSync(idFile, dhtrpc.id())
const id = fs.readFileSync(idFile).slice(0, 32)
const dht = require('./')({ ephemeral, adaptive: ephemeral, id })

console.log('node id: ' + dht.id.toString('hex'))
const quiet = process.argv.includes('--quiet')

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
