module.exports = class Sleeper {
  constructor () {
    this._timeout = null
    this._resolve = null

    this._start = (resolve) => {
      this._resolve = resolve
    }

    this._trigger = () => {
      if (this._resolve === null) return
      const resolve = this._resolve
      this._timeout = null
      this._resolve = null
      resolve()
    }
  }

  pause (ms) {
    const p = new Promise(this._start)
    if (this._timeout !== null) {
      clearTimeout(this._timeout)
      this._trigger()
    }
    this._timeout = setTimeout(this._trigger, ms)
    return p
  }

  resume () {
    if (this._timeout !== null) {
      clearTimeout(this._timeout)
      this._trigger()
    }
  }
}
