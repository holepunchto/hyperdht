const DHT = require('../../../')
const { Client: KHLClient } = require('keet-hypertrace-logger')

const publicKey = Buffer.from(process.argv[2], 'hex')
const secretKey = Buffer.from(process.argv[3], 'hex')
const bootstrap = JSON.parse(process.argv[4])
const keyPair = { publicKey, secretKey }
const khlClient = new KHLClient()
khlClient.start({
  createSocket: () => {
    const node = new DHT()
    return node.connect(Buffer.from('17ae5b10a5abdc269e16d740c1eb762f215c05a697c7e37c996abfcc488e82f3', 'hex'), {
      keyPair
    })
  },
  getInitialProps: () => ({ alias: 'server' })
})

main()

async function main () {
  const node = new DHT({
    bootstrap,
    quickFirewall: false
  })
  const server = node.createServer({
    holepunch: false, // To ensure it relies only on relaying
    shareLocalAddress: false, // To help ensure it relies only on relaying (otherwise it can connect directly over LAN, without even trying to holepunch)
    relayThrough: [
      '45ae429318f146326dddb27168532c7c6b21cacfdd4a43d539e06bd518a7893a',
      '26eb24c97e53f94d392842b3c0b3fddcb903a0883ac5691e67e4c9d369ef2332',
      '5c4ee2d0140670b433c0f844fe38264c022842cd9b76b5d28767b462531dfeb2',
      '8e2a691a6e0b0ede66bd45752b0165514fbec8844721eb038fbcc412af0eb691',
      '74bd888061f419745bd011367710e0ba98e0db0a2fb12ae1a21ba2d13d75a30c',
      '1dffaffb7cfe080b15aefae5fa18c2b7ad43facc8882b5d614fd45262f33e9c9',
      'f1154be6dcc4f98f38ab4dbfe751457907b14dac3c76d1ed654aa65c690c2968'
    ]
  }, socket => {
    socket.setKeepAlive(5000)
    socket
      .on('data', data => console.log(`socket_ondata ${data.toString()}`))
      .on('open', () => console.log(`socket_onopen ${socket.rawStream.remoteHost}`))
      .on('close', () => console.log('socket_onclose'))
      .on('error', err => console.log(`socket_onerror ${err.code}`))
  })
  server.on('open', () => console.log('server_onopen'))
  server.on('error', err => console.log(`server_onerror ${err.code}`))
  server.on('close', () => console.log('server_onclose'))

  await server.listen(keyPair)
  console.log('started')
}
