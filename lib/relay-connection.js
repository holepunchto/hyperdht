const b4a = require('b4a')

exports.clearRelayTimeout = clearRelayTimeout
exports.closeRelayConnection = closeRelayConnection
exports.confirmDirectUpgrade = confirmDirectUpgrade
exports.destroyRelayConnection = destroyRelayConnection

function clearRelayTimeout(connectionOrHandshake) {
  clearTimeout(connectionOrHandshake.relayTimeout)
  connectionOrHandshake.relayTimeout = null
}

function closeRelayConnection(connectionOrHandshake) {
  const socket = resetRelayConnection(connectionOrHandshake)

  if (socket) socket.end()
}

function confirmDirectUpgrade(connectionOrHandshake, rawStream, remoteChanging, opts = {}) {
  const cleanup = () => {
    rawStream.off('data', ondirect)
    rawStream.off('message', ondirect)
    rawStream.off('close', cleanup)
  }

  function ondirect() {
    if (!connectionOrHandshake.validUpgrade) {
      connectionOrHandshake.validUpgrade = true
      return
    }

    cleanup()
    closeRelayConnection(connectionOrHandshake)
  }

  const confirm = () => {
    rawStream.on('data', ondirect)
    rawStream.on('message', ondirect)
    rawStream.once('close', cleanup)

    // Use a raw UDX message to make the peer observe the direct path without
    // writing application data into the secret stream.
    if (opts.nudge && rawStream.trySend) rawStream.trySend(b4a.alloc(0))
  }

  if (!remoteChanging) {
    confirm()
    return null
  }

  return remoteChanging.then(confirm)
}

function destroyRelayConnection(connectionOrHandshake) {
  const socket = resetRelayConnection(connectionOrHandshake)

  if (socket) socket.destroy()
}

function resetRelayConnection(connectionOrHandshake) {
  if (connectionOrHandshake.relayTimeout) clearRelayTimeout(connectionOrHandshake)

  const socket = connectionOrHandshake.relaySocket
  // Drop relay references so the app connection no longer keeps relay state alive.
  connectionOrHandshake.relayToken = null
  connectionOrHandshake.relaySocket = null
  connectionOrHandshake.relayClient = null

  return socket
}
