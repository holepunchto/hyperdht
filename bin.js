#!/usr/bin/env node

const os = require('os')
const path = require('path')
const fs = require('fs')
const dhtrpc = require('dht-rpc')

const ephemeral = !process.argv.includes('--non-ephemeral')
const idFile = path.join(os.tmpdir(), 'dht-rpc-id')
if (!fs.existsSync(idFile)) fs.writeFileSync(idFile, dhtrpc.id())
const id = fs.readFileSync(idFile).slice(0, 32)

const quiet = process.argv.includes('--quiet')

const portRegex = /^(--port|-p)=(\d{1,5})$/
const portArg = process.argv.find(arg => portRegex.test(arg))
if (portArg) {
  const port = parseInt(portRegex.exec(portArg)[2], 10)
  const addrRegex = /^(--address|-a)=(.+)$/
  const addrArg = process.argv.find(arg => addrRegex.test(arg))
  const addr = addrArg ? addrArg[2] : null
  const socket = require('dgram').createSocket('udp4')

  socket.on('error', function (err) {
    console.log(`server error:\n${err.stack}`)
    socket.close()
    process.exit(1)
  })

  socket.on('listening', function () {
    const address = socket.address()
    console.log(`listening on socket: ${address.address}:${address.port}`)
    start(socket)
  })

  socket.bind(port, addr)
} else {
  start()
}

function start (socket) {
  const dht = require('./')({ ephemeral, adaptive: ephemeral, id, socket })
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
}
