const test = require('brittle')
const { swarm, createDHT } = require('../helpers')
const Holepuncher = require('../../lib/holepuncher')

test(
  'same-egress peers preserve fast-open when LAN route fails (CGNAT-like)',
  { timeout: 15000 },
  async function (t) {
    const { bootstrap } = await swarm(t, 5)
    const serverDHT = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })
    const clientDHT = createDHT({ bootstrap, quickFirewall: false, ephemeral: true })

    t.teardown(() => Promise.all([serverDHT.destroy(), clientDHT.destroy()]), {
      force: true,
      order: 1
    })

    await Promise.all([serverDHT.fullyBootstrapped(), clientDHT.fullyBootstrapped()])

    const serverPort = serverDHT.io.serverSocket.address().port
    const matchAddress = Holepuncher.matchAddress
    const ping = clientDHT.ping
    let lanAttempts = 0
    let coordinated = false

    // Model distinct peers sharing one public egress IP, as can happen behind
    // CGNAT. Sharing an external IP does not imply that their private addresses
    // are mutually reachable, so a failed LAN candidate must not disable an
    // otherwise viable fast-open route.
    Holepuncher.matchAddress = () => null

    clientDHT.ping = function (addr, ...args) {
      if (addr.port === serverPort) {
        lanAttempts++
        return Promise.reject(new Error('not actually on the same LAN'))
      }
      return ping.call(this, addr, ...args)
    }

    t.teardown(
      () => {
        Holepuncher.matchAddress = matchAddress
        clientDHT.ping = ping
      },
      { force: true, order: -1 }
    )

    const server = serverDHT.createServer(function (socket) {
      socket.on('data', (data) => socket.end(data))
    })
    await server.listen()
    t.teardown(() => server.close(), { force: true })

    const socket = clientDHT.connect(server.publicKey, {
      holepunch() {
        coordinated = true
        return false
      }
    })
    t.teardown(() => socket.destroy(), { force: true })

    const outcome = new Promise((resolve) => {
      socket.once('data', (data) => resolve({ event: 'data', data }))
      socket.once('error', (err) => resolve({ event: 'error', code: err.code }))
    })

    socket.end('ping')
    const result = await outcome

    t.ok(lanAttempts > 0, 'exercised false-LAN path')
    t.is(coordinated, false, 'fast-open won before coordinated punching')
    t.is(result.event, 'data', 'connection succeeded through intentional fast-open')
    if (result.data) t.alike(result.data, Buffer.from('ping'))
  }
)
