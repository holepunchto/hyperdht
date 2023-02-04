#!/usr/bin/env node

import DHT from '../index.js'

const node = new DHT()
await node.ready()

console.log('clientSocket', node.io.clientSocket.address())
console.log('serverSocket', node.io.serverSocket.address())

const socket = node.connect(Buffer.from(process.argv[2], 'hex'))

socket.on('open', function () {
  console.log('Socket open', socket.rawStream.remoteHost, socket.rawStream.remotePort)
})

socket.on('data', function (msg) {
  console.log('Data received:', msg.toString())
})

socket.write('hello world')

setTimeout(() => {
  console.log('Sending final write..')
  socket.write('hello world')
}, 3000)
