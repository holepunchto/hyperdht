const test = require('brittle')
const c = require('compact-encoding')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const HyperDHT = require('../')
const { swarm } = require('./helpers')
const m = require('../lib/messages')
const { COMMANDS: HYPERDHT_COMMANDS } = require('../lib/constants')
const DHTPlugin = require('../lib/plugin')

test('plugin put - get', async function (t) {
  const PLUGIN_COMMANDS = {
    PUT: 0,
    GET: 1
  }

  function mapTest(node) {
    return node
  }

  class TestPlugin extends DHTPlugin {
    constructor(dht) {
      super('testplugin')

      this.dht = dht
      this.data = new Map()
    }

    onrequest(req) {
      if (!req.value) return

      let plugreq
      try {
        plugreq = c.decode(m.pluginRequest, req.value)
      } catch {
        return
      }

      const { plugin, command, payload } = plugreq

      switch (command) {
        case PLUGIN_COMMANDS.PUT: {
          this.onput(req)
          return true
        }
        case PLUGIN_COMMANDS.GET: {
          this.onget(req)
          return true
        }
      }

      return false
    }

    destroy() {
      // Do nothing
    }

    onput(req) {
      if (!req.target || !req.token || !req.value) return

      let val
      try {
        const { plugin, command, payload } = c.decode(m.pluginRequest, req.value)
        val = payload
      } catch {
        return req.reply(null)
      }

      const k = b4a.toString(req.target, 'hex')
      this.data.set(k, val)
      req.reply(null)
    }

    onget(req) {
      if (!req.target) return
      const k = b4a.toString(req.target, 'hex')
      req.reply(this.data.get(k) || null)
    }

    async put(val) {
      const putReq = c.encode(m.pluginRequest, {
        plugin: this.name,
        command: PLUGIN_COMMANDS.PUT,
        payload: b4a.from(val, 'utf8')
      })

      const opts = {
        map: mapTest,
        commit(reply, dht) {
          return dht.request(
            {
              token: reply.token,
              target,
              command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
              value: putReq
            },
            reply.from
          )
        }
      }

      const target = b4a.allocUnsafe(32)
      sodium.crypto_generichash(target, b4a.from(val, 'utf8'))

      const getReq = c.encode(m.pluginRequest, {
        plugin: this.name,
        command: PLUGIN_COMMANDS.GET,
        payload: null
      })

      const query = this.dht.query(
        {
          target,
          command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
          value: getReq
        },
        opts
      )

      await query.finished()
      return { target, closestNodes: query.closestNodes }
    }

    async get(target) {
      const opts = { map: mapTest }

      const req = c.encode(m.pluginRequest, {
        plugin: this.name,
        command: PLUGIN_COMMANDS.GET,
        payload: null
      })

      const query = this.dht.query(
        {
          target,
          command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
          value: req
        },
        opts
      )

      for await (const node of query) {
        return node
      }

      return null
    }
  }

  const { nodes } = await swarm(t, 100)
  const pluginClients = []

  for (const node of nodes) {
    const p = new TestPlugin(node)
    pluginClients.push(p)
    node.register(p.name, p)
  }

  const put = await pluginClients[30].put('myTestValue')

  t.is(put.target.length, 32)

  const res = await pluginClients[30].get(put.target)
  const { value } = res

  t.is(b4a.toString(value, 'utf8'), 'myTestValue')
  t.is(typeof res.from, 'object')
  t.is(typeof res.from.host, 'string')
  t.is(typeof res.from.port, 'number')
  t.is(typeof res.to, 'object')
  t.is(typeof res.to.host, 'string')
  t.is(typeof res.to.port, 'number')
})
