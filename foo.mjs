import Hyperdht from './index.js'
import { setTracingFunction } from 'hypertrace'

const node = new Hyperdht()

const server = node.createServer(function (stream) {
  stream.end('hello world')
})

await server.listen()

const stream = node.connect(server.publicKey)

for await (const data of stream) {
  console.log('data', data)
}

await server.close()
