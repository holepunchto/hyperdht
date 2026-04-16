const c = require('compact-encoding')
const m = require('./messages')
const { COMMANDS: HYPERDHT_COMMANDS } = require('./constants')

module.exports = class Plugin {
  constructor(name) {
    this.name = name
    this.dht = null
  }

  onregister(dht) {
    this.dht = dht
  }

  onrequest(req) {
    throw new Error('onrequest() must be implemented')
  }

  destroy() {
    throw new Error('destroy() must be implemented')
  }

  request({ token = null, command, target = null, value = null }, to, opts) {
    const req = c.encode(m.pluginRequest, {
      plugin: this.name,
      command,
      value
    })

    return this.dht.request(
      {
        token,
        target,
        command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
        value: req
      },
      to,
      opts
    )
  }

  query({ command, target = null, value = null }, opts) {
    const req = c.encode(m.pluginRequest, {
      plugin: this.name,
      command,
      value
    })

    return this.dht.query(
      {
        target,
        command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
        value: req
      },
      opts
    )
  }
}
