module.exports = class Plugin {
  constructor(name) {
    this.name = name
  }

  onrequest(req) {
    throw new Error('onrequest() must be implemented')
  }

  destroy() {
    throw new Error('destroy() must be implemented')
  }
}
