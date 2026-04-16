const test = require('brittle')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const { swarm } = require('./helpers')
const m = require('../lib/messages')
// const { COMMANDS: HYPERDHT_COMMANDS } = require('../lib/constants')
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
      this.data = new Map()
    }

    onrequest(req) {
      let plugreq
      try {
        plugreq = c.decode(m.pluginRequest, req.value)
      } catch {
        return
      }

      const { command } = plugreq

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
        const { value } = c.decode(m.pluginRequest, req.value)
        val = value
      } catch {
        return req.reply(null)
      }

      const k = req.target.toString('hex')
      this.data.set(k, val)
      req.reply(null)
    }

    onget(req) {
      if (!req.target) return
      const k = req.target.toString('hex')
      req.reply(this.data.get(k) || null)
    }

    async put(val) {
      const opts = {
        map: mapTest,
        commit: (reply, dht) => {
          return this.request(
            {
              token: reply.token,
              target,
              command: PLUGIN_COMMANDS.PUT,
              value: Buffer.from(val)
            },
            reply.from
          )
        }
      }

      const target = Buffer.alloc(32)
      sodium.crypto_generichash(target, Buffer.from(val))

      const query = this.query(
        {
          target,
          command: PLUGIN_COMMANDS.GET,
          value: null
        },
        opts
      )

      await query.finished()
      return { target, closestNodes: query.closestNodes }
    }

    async get(target) {
      const opts = { map: mapTest }

      const query = this.query(
        {
          target,
          command: PLUGIN_COMMANDS.GET,
          value: null
        },
        opts
      )

      for await (const node of query) {
        if (node.value !== null) return node
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

  t.is(value.toString(), 'myTestValue')
  t.is(typeof res.from, 'object')
  t.is(typeof res.from.host, 'string')
  t.is(typeof res.from.port, 'number')
  t.is(typeof res.to, 'object')
  t.is(typeof res.to.host, 'string')
  t.is(typeof res.to.port, 'number')
})
