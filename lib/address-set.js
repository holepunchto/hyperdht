module.exports = class AddressSet {
  constructor () {
    this.a = new Set()
    this.b = new Set()
    this.c = new Set()
  }

  gc () {
    const oldest = this.c
    oldest.clear()

    this.c = this.b
    this.b = this.a
    this.a = oldest
  }

  add (host, port) {
    this.a.add(host + ':' + port)
  }

  delete (host, port) {
    const id = host + ':' + port
    this.a.delete(id)
    this.b.delete(id)
    this.c.delete(id)
  }

  has (host, port) {
    const id = host + ':' + port
    return this.a.has(id) || this.b.has(id) || this.c.has(id)
  }
}
