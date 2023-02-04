#!/usr/bin/env node

import DHT from '../index.js'

const node = new DHT()
await node.ready()

console.log('clientSocket', node.io.clientSocket.address())
console.log('serverSocket', node.io.serverSocket.address())

const server = node.createServer()

server.on('connection', function (socket) {
  console.log('New connection:', socket.rawStream.remoteHost, socket.rawStream.remotePort)

  socket.on('data', function (msg) {
    console.log('Data received:', msg.toString())
  })

  socket.write('hello world')

  setTimeout(() => {
    console.log('Sending final write..')
    socket.write('hello world')
  }, 3000)
})

const keyPair = DHT.keyPair()
await server.listen(keyPair)

console.log('Server public key:')
console.log(keyPair.publicKey.toString('hex'))
