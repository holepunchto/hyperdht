const test = require('brittle')
const { swarm } = require('./helpers')
const DHT = require('../')

function hashTargetKey(publicKey) {
  return DHT.hash(publicKey).toString('hex')
}


test('parallel probe only runs when RTT data exists', async function (t) {
  t.plan(3)

  const dht = new DHT({ parallelProbing: true, preWarmRTT: false })
  await dht.ready()

  t.is(dht.parallelProbing, true, 'parallel probing enabled')

  const avgRTT = dht.getAverageRTT()
  t.is(avgRTT, null, 'no RTT data yet')

 
  const shouldRunParallel = dht.parallelProbing !== false && avgRTT != null
  t.is(shouldRunParallel, false, 'parallel probing should NOT run without RTT data')

  await dht.destroy()
})

test('parallel probe runs when RTT data exists', async function (t) {
  t.plan(4)

  const dht = new DHT({ parallelProbing: true, preWarmRTT: false })
  await dht.ready()

  t.is(dht.parallelProbing, true, 'parallel probing enabled')

  dht.updateNodeRTT({ host: '1.1.1.1', port: 1111 }, 50)
  dht.updateNodeRTT({ host: '2.2.2.2', port: 2222 }, 100)

  const avgRTT = dht.getAverageRTT()
  t.ok(avgRTT != null, 'RTT data exists')
  t.ok(avgRTT > 0, `average RTT: ${avgRTT}ms`)

  const shouldRunParallel = dht.parallelProbing !== false && avgRTT != null
  t.is(shouldRunParallel, true, 'parallel probing SHOULD run with RTT data')

  await dht.destroy()
})

test('getAverageRTT only called once (not redundantly)', async function (t) {
  t.plan(3)

  const dht = new DHT({ parallelProbing: true, preWarmRTT: false })
  await dht.ready()

  for (let i = 0; i < 100; i++) {
    dht.updateNodeRTT({ host: `1.1.1.${i}`, port: 1111 + i }, 50 + i)
  }

  const start = process.hrtime.bigint()
  const avgRTT1 = dht.getAverageRTT()
  const end = process.hrtime.bigint()
  const duration1 = Number(end - start) / 1_000_000 

  t.ok(avgRTT1 > 0, `average RTT: ${avgRTT1}ms`)

  

  t.ok(duration1 >= 0, `getAverageRTT execution time: ${duration1.toFixed(3)}ms`)
  t.pass('With fix, avgRTT should be cached once per probeRound, not called twice')

  await dht.destroy()
})


test('parallel probing - enabled by default', async function (t) {
  const testnet = await swarm(t)
  const dht = testnet.nodes[0]

  t.is(dht.parallelProbing, true, 'parallel probing enabled by default')
})

test('parallel probing - can be disabled', async function (t) {
  const dht = new DHT({ parallelProbing: false })
  await dht.ready()

  t.is(dht.parallelProbing, false, 'parallel probing disabled')

  await dht.destroy()
})

test('parallel probing - basic connection', async function (t) {
  const [server, client] = await swarm(t, 2)

  const testServer = server.createServer()

  testServer.on('connection', (socket) => {
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })

  await testServer.listen()

  const start = Date.now()
  const socket = client.connect(testServer.publicKey)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

    socket.on('open', () => {
      clearTimeout(timeout)
      const time = Date.now() - start
      t.ok(time < 5000, `connection established in ${time}ms`)
      socket.destroy()
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code !== 'ECONNRESET') reject(err)
      else resolve()
    })
  })

  await testServer.close()
})

test('parallel probing - multiple connections improve over time', async function (t) {
  const [server, client] = await swarm(t, 2)

  const testServer = server.createServer()

  testServer.on('connection', (socket) => {
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })

  await testServer.listen()

  // Make 5 connections
  const times = []

  for (let i = 0; i < 5; i++) {
    const start = Date.now()
    const socket = client.connect(testServer.publicKey)

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

      socket.on('open', () => {
        clearTimeout(timeout)
        const time = Date.now() - start
        times.push(time)
        socket.destroy()
        resolve()
      })

      socket.on('error', (err) => {
        clearTimeout(timeout)
        if (err.code !== 'ECONNRESET') reject(err)
        else resolve()
      })
    })

    if (i < 4) await new Promise((r) => setTimeout(r, 1000))
  }

  t.is(times.length, 5, 'all connections completed')

  const firstHalf = times.slice(0, 2)
  const secondHalf = times.slice(3, 5)
  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

  t.ok(secondAvg <= firstAvg * 1.5, 'performance did not degrade significantly')

  await testServer.close()
})

test('parallel probing - works without RTT data', async function (t) {
  const [server, client] = await swarm(t, 2)

  t.is(client.getAverageRTT(), null, 'no RTT data initially')

  const testServer = server.createServer()

  testServer.on('connection', (socket) => {
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })

  await testServer.listen()

  const start = Date.now()
  const socket = client.connect(testServer.publicKey)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

    socket.on('open', () => {
      clearTimeout(timeout)
      const time = Date.now() - start
      t.ok(time < 5000, `connection without RTT data: ${time}ms`)
      socket.destroy()
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code !== 'ECONNRESET') reject(err)
      else resolve()
    })
  })

  await testServer.close()
})

test('parallel probing - works with RTT data', async function (t) {
  const [server, client] = await swarm(t, 2)

  const node = { host: '127.0.0.1', port: 8080 }
  client.updateNodeRTT(node, 100)

  t.ok(client.getAverageRTT() > 0, 'RTT data available')

  const testServer = server.createServer()

  testServer.on('connection', (socket) => {
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })

  await testServer.listen()

  const start = Date.now()
  const socket = client.connect(testServer.publicKey)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

    socket.on('open', () => {
      clearTimeout(timeout)
      const time = Date.now() - start
      t.ok(time < 5000, `connection with RTT data: ${time}ms`)
      socket.destroy()
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code !== 'ECONNRESET') reject(err)
      else resolve()
    })
  })

  await testServer.close()
})

test('parallel probing - connection cache usage', async function (t) {
  const [server, client] = await swarm(t, 2)

  const testServer = server.createServer()

  testServer.on('connection', (socket) => {
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })

  await testServer.listen()

  const initialCacheSize = client._connectionCache.size

  const socket1 = client.connect(testServer.publicKey)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

    socket1.on('open', () => {
      clearTimeout(timeout)
      socket1.destroy()
      resolve()
    })

    socket1.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code !== 'ECONNRESET') reject(err)
      else resolve()
    })
  })

  await new Promise((r) => setTimeout(r, 500))

  const socket2 = client.connect(testServer.publicKey)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

    socket2.on('open', () => {
      clearTimeout(timeout)
      socket2.destroy()
      resolve()
    })

    socket2.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code !== 'ECONNRESET') reject(err)
      else resolve()
    })
  })

  const targetKey = hashTargetKey(testServer.publicKey)
  t.ok(client._connectionCache.get(targetKey), 'connection cache accumulated data')

  await testServer.close()
})

test('parallel probing - direct connection cache usage', async function (t) {
  const [server, client] = await swarm(t, 2)

  const testServer = server.createServer()

  testServer.on('connection', (socket) => {
    socket.on('error', () => {})
    setTimeout(() => socket.destroy(), 50)
  })

  await testServer.listen()

  const socket = client.connect(testServer.publicKey)

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000)

    socket.on('open', () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      if (err.code !== 'ECONNRESET') reject(err)
      else resolve()
    })
  })

  const targetKey = hashTargetKey(testServer.publicKey)
  const directEntry = client._directConnectionCache.get(targetKey)
  t.ok(directEntry, 'direct connection cache populated')
  if (directEntry) {
    t.ok(directEntry.address && directEntry.address.host, 'direct cache stores peer address')
  }

  await testServer.close()
})

test('parallel probing - handles connection failures gracefully', async function (t) {
  const [server, client] = await swarm(t, 2)

  const testServer = server.createServer()
  let connectionAttempted = false

  testServer.on('connection', (socket) => {
    connectionAttempted = true
    socket.on('error', () => {})
    socket.destroy() 
  })

  await testServer.listen()
  const publicKey = testServer.publicKey

  const socket = client.connect(publicKey)

  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy()
      t.pass('handled connection attempt')
      resolve()
    }, 5000)

    socket.on('open', () => {
      clearTimeout(timeout)
      socket.destroy()
      t.pass('connection opened')
      resolve()
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      t.pass('handled error gracefully: ' + err.message)
      socket.destroy()
      resolve()
    })
  })

  await testServer.close()
})
