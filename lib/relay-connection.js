exports.clearRelayTimeout = clearRelayTimeout
exports.closeRelayConnection = closeRelayConnection
exports.destroyRelayConnection = destroyRelayConnection

function clearRelayTimeout(connectionOrHandshake) {
  clearTimeout(connectionOrHandshake.relayTimeout)
  connectionOrHandshake.relayTimeout = null
}

function closeRelayConnection(connectionOrHandshake) {
  const socket = resetRelayConnection(connectionOrHandshake)

  if (socket) socket.end()
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
