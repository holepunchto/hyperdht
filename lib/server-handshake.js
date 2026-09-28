module.exports = class ServerHandshake {
  constructor(relayRecoveryWait, onclear = noop) {
    this.round = 0
    this.reply = null
    this.puncher = null
    this.payload = null
    this.rawStream = null
    this.encryptedSocket = null
    this.prepunching = null
    this.firewalled = true
    this.clearing = null
    this.replyFromPuncher = false
    this.onsocket = null
    this.aborted = false
    this.activeHolepunchRequests = 0

    this.relayTimeout = null
    this.relayToken = null
    this.relaySocket = null
    this.relayClient = null
    this.relayPaired = false
    this.validUpgrade = true

    this.relayFailedAt = null
    this.relayRecoveryTimeout = null
    this._relayRecoveryWait = relayRecoveryWait
    this._onclear = onclear
  }

  waitForPunch(timeout) {
    this.endPrepunch()
    this._clearRecoveryTimeout()
    this.prepunching = setTimeout(() => this.abort(), timeout)
  }

  endPrepunch() {
    if (this.prepunching !== null) clearTimeout(this.prepunching)
    this.prepunching = null
  }

  startRequest() {
    this.activeHolepunchRequests++
    this._clearRecoveryTimeout()
  }

  endRequest() {
    this.activeHolepunchRequests--
    this._recover()
  }

  relayLost() {
    if (this.relayFailedAt === null) this.relayFailedAt = Date.now()
    this._recover()
  }

  directConnected() {
    this.clearRecovery()
    this.endPrepunch()
  }

  closed() {
    this.clearRecovery()
    this.stopPuncher()
    this._onclear()
  }

  abort() {
    this.aborted = true
    this.clearRecovery()
    this.endPrepunch()
    this.stopPuncher()
    if (this.rawStream === null) return
    if (this.rawStream.destroyed) {
      this._onclear()
      return
    }

    this.rawStream.on('close', this._onclear)
    if (this.relayToken === null) this.rawStream.destroy()
  }

  stopPuncher() {
    if (!this.puncher) return
    this.puncher.onabort = noop
    this.puncher.destroy()
  }

  destroy() {
    if (this.puncher) this.puncher.destroy()
    if (this.clearing !== null) clearTimeout(this.clearing)
    this.endPrepunch()
    this.clearRecovery()
    if (this.rawStream) this.rawStream.destroy()
  }

  clearRecovery() {
    this._clearRecoveryTimeout()
    this.relayFailedAt = null
  }

  _clearRecoveryTimeout() {
    if (this.relayRecoveryTimeout !== null) clearTimeout(this.relayRecoveryTimeout)
    this.relayRecoveryTimeout = null
  }

  _recover() {
    if (this.relayFailedAt === null || this.rawStream === null || this.rawStream.destroyed) return

    if (this.aborted) {
      this.rawStream.destroy()
      return
    }

    // Active work owns completion; this deadline only bounds waiting between rounds.
    if (this.prepunching !== null || this.activeHolepunchRequests > 0) return
    if (this.puncher && this.puncher.punching) return

    const remaining = this._relayRecoveryWait - (Date.now() - this.relayFailedAt)
    if (remaining > 0) {
      if (this.relayRecoveryTimeout !== null) return

      // No puncher is required: the peer may still establish a passive direct route.
      this.relayRecoveryTimeout = setTimeout(() => {
        this.relayRecoveryTimeout = null
        this._recover()
      }, remaining)
      this.relayRecoveryTimeout.unref()
      return
    }

    this._clearRecoveryTimeout()
    this.rawStream.destroy()
  }
}

function noop() {}
