const { once } = require('events')
const crypto = require('crypto')
const createTestnet = require('../../testnet')
const DHT = require('../..')

const RELAY_TTL = 60_000

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})

async function main() {
  const testnet = await createTestnet(8)
  const group = new GroupState('family-chat')
  const sockets = new Set()

  const alice = new Participant('alice', testnet)
  const bob = new Participant('bob', testnet)
  const carol = new Participant('carol', testnet)
  const dana = new Participant('dana', testnet)

  group.addMember(alice)
  group.addMember(bob)
  group.addMember(carol)
  group.addMember(dana)

  let appServer = null

  try {
    console.log('group created with normal members: bob, carol')
    console.log('relay-capable members: alice, dana')

    await alice.enableRelay(group)
    await dana.enableRelay(group)

    appServer = carol.dht.createServer(
      {
        holepunch: false,
        relayKeepAlive: 250,
        shareLocalAddress: false,
        relayThrough: () => group.pickRelay().publicKey
      },
      handleChatSocket
    )
    await appServer.listen()
    carol.serverPublicKey = appServer.publicKey

    console.log('carol chat server listening:', shortKey(appServer.publicKey))

    await sendChat({
      from: bob,
      to: carol,
      group,
      sockets,
      text: 'hello through the first approved relay',
      expectedRelay: 'alice'
    })

    const activeChat = await openChatSession({ from: bob, to: carol, group, sockets })
    assert(activeChat.relay.owner === 'alice', 'expected active chat through alice')
    await expectChatReply(activeChat, 'keeping this chat open')
    console.log('active chat opened through relay:', activeChat.relay.owner)

    console.log('alice disables relay mode in app settings')
    const activeChatStopped = waitForSocketStopped(activeChat.socket)
    await alice.disableRelay(group)
    const status = await activeChatStopped
    activeChat.socket.destroy()
    sockets.delete(activeChat.socket)
    console.log(`active chat ${status} after alice stopped relaying`)

    await sendChat({
      from: bob,
      to: carol,
      group,
      sockets,
      text: 'hello again after alice disabled relay mode',
      expectedRelay: 'dana'
    })

    console.log('dana disables relay mode too')
    await dana.disableRelay(group)

    try {
      connectThroughGroupRelay({ from: bob, to: carol, group, sockets })
    } catch (err) {
      console.log('connect skipped:', err.message)
    }
  } finally {
    for (const socket of sockets) socket.destroy()
    if (appServer) await appServer.close()
    await alice.disableRelay(group)
    await dana.disableRelay(group)
    await testnet.destroy()
  }
}

async function sendChat({ from, to, group, sockets, text, expectedRelay }) {
  const chat = await openChatSession({ from, to, group, sockets })
  assert(chat.relay.owner === expectedRelay, `expected relay ${expectedRelay}`)

  const reply = await expectChatReply(chat, text)
  chat.socket.end()

  console.log('chat used relay:', chat.relay.owner, `("${reply.text}")`)
}

async function openChatSession({ from, to, group, sockets }) {
  const { socket, relay } = connectThroughGroupRelay({ from, to, group, sockets })
  const lines = new JsonLines()
  const pending = []

  socket.on('data', (data) => {
    for (const msg of lines.push(data)) {
      const next = pending.shift()
      if (next) next.resolve(msg)
    }
  })

  socket.once('error', (err) => rejectPending(pending, err))
  socket.once('close', () => {
    sockets.delete(socket)
    rejectPending(pending, new Error('chat session closed'))
  })

  await waitForOpen(socket)

  return {
    socket,
    relay,
    send(text) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
        socket.write(encode({ type: 'chat', text }))
      })
    }
  }
}

async function expectChatReply(chat, text) {
  const reply = await chat.send(text)
  const expected = `carol received: ${text}`

  assert(reply.type === 'chat-reply', 'expected chat reply')
  assert(reply.text === expected, 'unexpected chat reply')

  return reply
}

function connectThroughGroupRelay({ from, to, group, sockets }) {
  const relay = group.pickRelay()
  const socket = from.dht.connect(to.serverPublicKey, {
    holepunch: false,
    localConnection: false,
    relayKeepAlive: 250,
    relayThrough: relay.publicKey
  })

  sockets.add(socket)

  return { socket, relay }
}

function handleChatSocket(socket) {
  const lines = new JsonLines()

  socket.on('data', (data) => {
    for (const msg of lines.push(data)) handleChatMessage(socket, msg)
  })

  socket.on('error', noop)
  socket.on('end', () => socket.end())
}

function handleChatMessage(socket, msg) {
  if (msg.type !== 'chat') {
    socket.destroy(new Error(`unknown message type: ${msg.type}`))
    return
  }

  socket.write(encode({ type: 'chat-reply', text: `carol received: ${msg.text}` }))
}

class GroupState {
  constructor(name) {
    this.name = name
    this.members = new Map()
    this.relays = new Map()
  }

  addMember(participant) {
    this.members.set(participant.memberId, participant.name)
  }

  publishRelay(participant, relay) {
    assert(this.members.has(participant.memberId), 'only group members can publish relays')

    this.relays.set(participant.memberId, {
      owner: participant.name,
      ownerPublicKey: participant.publicKey,
      publicKey: relay.publicKey,
      protocol: 'hyperdht-blind-relay',
      version: 1,
      updatedAt: Date.now(),
      expiresAt: Date.now() + RELAY_TTL
    })

    console.log(`${participant.name} enabled relay mode:`, shortKey(relay.publicKey))
  }

  removeRelay(participant) {
    if (this.relays.delete(participant.memberId)) {
      console.log(`${participant.name} removed relay metadata`)
    }
  }

  pickRelay() {
    const now = Date.now()

    for (const relay of this.relays.values()) {
      if (!this.members.has(key(relay.ownerPublicKey))) continue
      if (relay.version !== 1) continue
      if (relay.expiresAt <= now) continue
      return relay
    }

    throw new Error('no fresh group-approved relay is available')
  }
}

class Participant {
  constructor(name, testnet) {
    this.name = name
    this.keyPair = DHT.keyPair(seed(name))
    this.publicKey = this.keyPair.publicKey
    this.memberId = key(this.publicKey)
    this.dht = testnet.createNode({ keyPair: this.keyPair, quickFirewall: false })
    this.relay = null
    this.serverPublicKey = null
  }

  async enableRelay(group) {
    if (this.relay) return

    this.relay = this.dht.createRelayServer()
    await this.relay.listen()
    group.publishRelay(this, this.relay)
  }

  async disableRelay(group) {
    if (!this.relay) return

    const relay = this.relay
    this.relay = null
    group.removeRelay(this)
    await relay.close({ force: true })
  }
}

class JsonLines {
  constructor() {
    this.buffer = ''
  }

  push(data) {
    this.buffer += data.toString()

    const messages = []
    let index = this.buffer.indexOf('\n')

    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) messages.push(JSON.parse(line))
      index = this.buffer.indexOf('\n')
    }

    return messages
  }
}

async function waitForOpen(socket) {
  await Promise.race([
    once(socket, 'open'),
    once(socket, 'error').then(([err]) => {
      throw err
    }),
    once(socket, 'close').then(() => {
      throw new Error('socket closed before open')
    })
  ])
}

function waitForSocketStopped(socket) {
  return new Promise((resolve) => {
    let settled = false

    socket.once('close', () => finish('closed'))
    socket.once('error', (err) => finish(`failed (${err.code || err.message})`))

    function finish(status) {
      if (settled) return
      settled = true
      resolve(status)
    }
  })
}

function rejectPending(pending, err) {
  while (pending.length > 0) pending.shift().reject(err)
}

function encode(msg) {
  return JSON.stringify(msg) + '\n'
}

function seed(name) {
  return crypto.createHash('sha256').update(`app-level-relay:${name}`).digest()
}

function key(publicKey) {
  return publicKey.toString('hex')
}

function shortKey(publicKey) {
  return key(publicKey).slice(0, 16)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function noop() {}
