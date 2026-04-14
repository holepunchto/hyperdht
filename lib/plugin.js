const c = require('compact-encoding')
const { COMMANDS: HYPERDHT_COMMANDS } = require('./constants')
const m = require('./messages')

module.exports = class Plugin {
  constructor(name) {
    this.name = name
  }

  request({ token = null, command, target = null, payload = null }, to, opts) {
    const value = c.encode(m.pluginRequest, {
      plugin: this.name,
      command,
      payload
    })

    return this.dht.request(
      {
        token,
        target,
        command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
        value
      },
      to,
      opts
    )
  }

  query({ command, target = null, payload = null }, opts) {
    const value = c.encode(m.pluginRequest, {
      plugin: this.name,
      command,
      payload
    })

    return this.dht.query(
      {
        target,
        command: HYPERDHT_COMMANDS.PLUGIN_PERSISTENT,
        value
      },
      opts
    )
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
}
