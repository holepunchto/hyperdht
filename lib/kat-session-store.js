module.exports = class KatSessionStore {
  constructor (rotateInterval) {
    this.newest = new Map()
    this.oldest = new Map()
    this.interval = setInterval(this._rotate.bind(this), rotateInterval)
  }

  get size () {
    return this.oldest.size + this.newest.size
  }

  set (id, s) {
    this.newest.set(id.toString('hex'), s)
  }

  get (id) {
    const hex = id.toString('hex')
    return this.newest.get(hex) || this.oldest.get(hex)
  }

  delete (id) {
    const hex = id.toString('hex')
    this.newest.delete(hex)
    this.oldest.delete(hex)
  }

  destroy () {
    clearInterval(this.interval)
    this.newest.clear()
    this.oldest.clear()
  }

  _rotate () {
    const tmp = this.newest
    this.oldest.clear()
    this.newest = this.oldest
    this.oldest = tmp
  }
}
