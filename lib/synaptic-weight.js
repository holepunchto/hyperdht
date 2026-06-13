module.exports = class SynapticWeight {
  constructor(opts = {}) {
    this.lambda = opts.lambda || 0.01
    this.alpha = opts.alpha || 0.1
    this.beta = opts.beta || 0.5
    this.delta = opts.delta || 0.3
    this.threshold = opts.threshold || 0.02
  }

  updateOnSuccess(weight, latency, bandwidth) {
    const quality = bandwidth / (latency + 1)
    const decay = (1 - this.lambda) * weight
    const reward = this.alpha * quality
    return clamp(decay + reward)
  }

  updateOnFailure(weight) {
    const decay = (1 - this.lambda) * weight
    const penalty = this.beta
    return clamp(decay - penalty)
  }

  updateOnBackpressure(weight, isOverloaded) {
    if (!isOverloaded) return weight
    return clamp(weight - this.delta)
  }

  softmax(weights, temperature = 0.1) {
    const max = Math.max(...weights)
    const exps = weights.map(w => Math.exp((w - max) / temperature))
    const sum = exps.reduce((a, b) => a + b, 0)
    return exps.map(e => e / sum)
  }

  routePeer(peers, temperature = 0.1) {
    const active = peers.filter(p => p.weight > this.threshold)
    if (active.length === 0) return peers[Math.floor(Math.random() * peers.length)] || null

    const weights = active.map(p => p.weight)
    const probs = this.softmax(weights, temperature)
    let r = Math.random()
    for (let i = 0; i < active.length; i++) {
      r -= probs[i]
      if (r <= 0) return active[i]
    }
    return active[active.length - 1]
  }
}

function clamp(v) {
  return Math.max(0, Math.min(1, v))
}
