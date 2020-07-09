exports.ipv4 = {
  decodeAll (buf) {
    if (!buf) return null

    const peers = []
    if (buf.length % 6) return null

    for (var i = 0; i < buf.length; i += 6) {
      const host = getIp(buf, i)
      const port = buf.readUInt16BE(i + 4)

      if (port === 0 || host === '0.0.0.0') return null
      peers.push({ host, port })
    }

    return peers
  },
  encode (peer) {
    if (!peer) return null

    const buf = Buffer.allocUnsafe(6)
    setIp(buf, 0, peer.host)
    buf.writeUInt16BE(peer.port, 4)
    return buf
  }
}

exports.local = {
  decodeAll (prefix, buf) {
    if (!buf) return null

    const host = prefix[0] + '.' + prefix[1] + '.'
    const peers = []

    if (buf.length & 3) return null

    for (var i = 0; i < buf.length; i += 4) {
      const port = buf.readUInt16BE(i + 2)
      if (!port) return null
      peers.push({
        host: host + buf[i] + '.' + buf[i + 1],
        port
      })
    }

    return peers
  },
  encode: exports.ipv4.encode
}

function getIp (buf, offset) {
  return buf[offset] + '.' + buf[offset + 1] + '.' + buf[offset + 2] + '.' + buf[offset + 3]
}

function setIp (buf, offset, ip) {
  const n = ip.split('.')
  buf[offset] = Number(n[0])
  buf[offset + 1] = Number(n[1])
  buf[offset + 2] = Number(n[2])
  buf[offset + 3] = Number(n[3])
}
