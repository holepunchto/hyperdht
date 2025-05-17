const b4a = require('b4a')
const dgram = require("dgram");
const { SocksClient } = require("socks");

const LINGER_TIME = 3000;

class TorBoundSocketWrapper {
  constructor(dgramSocket, getSocksUdpRelay) {
    this._dgramSocket = dgramSocket;
    this._getSocksUdpRelay = getSocksUdpRelay;
    this._eventListeners = new Map();
  }

  send(buffer, port, host, cb) {
    const socksUdpRelay = this._getSocksUdpRelay();
    if (!socksUdpRelay) {
      const err = new Error("SOCKS UDP relay not established or available yet for send.");
      if (cb) process.nextTick(() => cb(err));
      else console.error("[TorBoundSocketWrapper] Send Error:", err.message);
      return;
    }

    let frame;
    try {
      frame = SocksClient.createUDPFrame({
        remoteHost: { host, port },
        data: buffer,
      });
    } catch (err) {
      if (cb) process.nextTick(() => cb(err));
      else console.error("[TorBoundSocketWrapper] Error creating SOCKS UDP frame:", err);
      return;
    }

    this._dgramSocket.send(frame, socksUdpRelay.port, socksUdpRelay.host, cb);
  }

  address() {
    return this._dgramSocket.address();
  }

  close(cb) {
    this._dgramSocket.close(cb);
  }

  get idle() {
    return true;
  }

  on(eventName, listener) {
    if (!this._eventListeners.has(eventName)) {
      this._eventListeners.set(eventName, []);
    }
    this._eventListeners.get(eventName).push(listener);
    return this;
  }

  removeListener(eventName, listener) {
    if (this._eventListeners.has(eventName)) {
      const listeners = this._eventListeners.get(eventName);
      const index = listeners.indexOf(listener);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
    return this;
  }

  ref() {}
  unref() {}
}

module.exports = class SocketPool {
  constructor(dht, host) {
    this._dht = dht;
    this._sockets = new Map();
    this._lingering = new Set(); // updated by the ref
    this._host = host;

    this.routes = new SocketRoutes(this);
  }

  _onmessage(ref, data, address) {
    this._dht.onmessage(ref.socket, data, address);
  }

  _add(ref) {
    this._sockets.set(ref.socket, ref);
  }

  _remove(ref) {
    this._sockets.delete(ref.socket);
    this._lingering.delete(ref);
  }

  lookup(socket) {
    return this._sockets.get(socket) || null;
  }

  setReusable(socket, bool) {
    const ref = this.lookup(socket);
    if (ref) ref.reusable = bool;
  }

  acquire() {
    // TODO: Enable socket reuse
    return new SocketRef(this);
  }

  async destroy() {
    const closing = [];

    for (const ref of this._sockets.values()) {
      ref._unlinger();
      closing.push(ref.socket.close());
    }

    await Promise.allSettled(closing);
  }
};

class SocketRoutes {
  constructor(pool) {
    this._pool = pool;
    this._routes = new Map();
  }

  add(publicKey, rawStream) {
    if (rawStream.socket) this._onconnect(publicKey, rawStream);
    else rawStream.on("connect", this._onconnect.bind(this, publicKey, rawStream));
  }

  get(publicKey) {
    const id = b4a.toString(publicKey, "hex");
    const route = this._routes.get(id);
    if (!route) return null;
    return route;
  }

  _onconnect(publicKey, rawStream) {
    const id = b4a.toString(publicKey, "hex");
    const socket = rawStream.socket;

    let route = this._routes.get(id);

    if (!route) {
      const gc = () => {
        if (this._routes.get(id) === route) this._routes.delete(id);
        socket.removeListener("close", gc);
      };

      route = {
        socket,
        address: { host: rawStream.remoteHost, port: rawStream.remotePort },
        gc,
      };

      this._routes.set(id, route);
      socket.on("close", gc);
    }

    this._pool.setReusable(socket, true);

    rawStream.on("error", () => {
      this._pool.setReusable(socket, false);
      if (!route) route = this._routes.get(id);
      if (route && route.socket === socket) route.gc();
    });
  }
}

// TODO: we should just make some "user data" object on udx to allow to attach this info
class SocketRef {
  constructor(pool) {
    this._pool = pool;

    // Events
    this.onholepunchmessage = noop;

    // Whether it should teardown immediately or wait a bit
    this.reusable = false;

    this._refs = 1;
    this._released = false;
    this._closed = false;

    this._timeout = null;
    this._wasBusy = false;

    this._pool._add(this);

    if (this._pool._dht.tor) {
      this._initTorSocket().catch((err) => {
        console.error("Failed to initialize Tor socket in SocketRef constructor:", err);
        this._closed = true;
        this._pool._remove(this);
      });
    } else {
      this._initDirectSocket();
    }
  }

  async _initTorSocket() {
    this.isTor = true;
    this._torDgramSocket = dgram.createSocket("udp4");

    this._torDgramSocket.on("error", (err) => {
      console.error("Tor SOCKS dgram socket error:", err);
      this._closed = true; // Mark as closed first
      if (this.socksControlSocketInfo && this.socksControlSocketInfo.socket) {
        this.socksControlSocketInfo.socket.destroy();
        this.socksControlSocketInfo = null;
      }
      this._pool._remove(this);
    });

    this._torDgramSocket.on("message", (data, addressInfo) => {
      if (this._closed) return;
      if (!this.socksUdpRelay || addressInfo.port !== this.socksUdpRelay.port || addressInfo.address !== this.socksUdpRelay.host) {
        return;
      }
      try {
        const frame = SocksClient.parseUDPFrame(data);
        this._dispatchMessage(frame.data, frame.remoteHost);
      } catch (err) {
        console.error("Failed to parse SOCKS UDP frame:", err, data);
      }
    });

    this._torDgramSocket.on("close", () => {
      if (!this._closed) {
        this._onclose();
      }
    });

    await new Promise((resolve, reject) => {
      this._torDgramSocket.once("listening", resolve);
      this._torDgramSocket.once("error", reject);
      this._torDgramSocket.bind();
    }).catch((err) => {
      console.error("Tor dgram socket bind error:", err);
      this._closed = true;
      this._pool._remove(this);
      throw err;
    });

    const socksOptions = {
      proxy: {
        host: this._pool._dht.socksHost,
        port: this._pool._dht.socksPort,
        type: 5,
      },
      command: "associate",
      destination: {
        host: "0.0.0.0",
        port: 0,
      },
      timeout: 15000,
    };

    try {
      this.socksClient = new SocksClient(socksOptions);

      this.socksClient.on("established", (info) => {
        if (this._closed) return;
        console.log("SOCKS UDP Relay established:", info.remoteHost);
        this.socksUdpRelay = info.remoteHost;

        this.socket = new TorBoundSocketWrapper(this._torDgramSocket, () => this.socksUdpRelay);
      });

      this.socksClient.on("error", (err) => {
        console.error("SOCKS client (TCP control) error:", err);
        if (!this._closed) {
          this._closed = true;
          this._torDgramSocket.close();
        }
      });

      this.socksControlSocketInfo = await this.socksClient.connect();
    } catch (err) {
      console.error("Failed to establish SOCKS UDP association (connect error):", err);
      if (!this._closed) {
        this._closed = true;
        this._torDgramSocket.close();
      }
      throw err;
    }
  }

  _initDirectSocket() {
    this.isTor = false;
    this.socket = this._pool._dht.udx.createSocket();
    this.socket
      .on("close", () => {
        if (!this._closed) {
          this._onclose();
        }
      })
      .on("message", this._dispatchMessage.bind(this))
      .on("idle", this._onidle.bind(this))
      .on("busy", this._onbusy.bind(this))
      .bind(0, this._pool._host);
  }

  _dispatchMessage(payload, address) {
    if (this._closed) return;

    if (payload.byteLength > 1) {
      this._pool._onmessage(this, payload, address);
    } else {
      this.onholepunchmessage(payload, address, this);
    }
  }

  _onclose() {
    if (this._closed && !this.isTor) return;

    if (this.isTor) {
      if (this.socksControlSocketInfo && this.socksControlSocketInfo.socket) {
        this.socksControlSocketInfo.socket.destroy();
        this.socksControlSocketInfo = null;
      }
    }

    this._closed = true;
    this._unlinger();
    this._pool._remove(this);
  }

  _onidle() {
    this._closeMaybe();
  }

  _onbusy() {
    this._wasBusy = true;
    this._unlinger();
  }

  _reset() {
    this.onholepunchmessage = noop;
  }

  _closeMaybe() {
    if (this._refs === 0 && this.socket.idle && !this._timeout) this._close();
  }

  _lingeringClose() {
    this._pool._lingering.delete(this);
    this._timeout = null;
    this._closeMaybe();
  }

  _close() {
    this._unlinger();

    if (this.reusable && this._wasBusy && !this.isTor) {
      this._wasBusy = false;
      this._pool._lingering.add(this);
      this._timeout = setTimeout(this._lingeringClose.bind(this), LINGER_TIME);
      return;
    }

    if (!this._closed) {
      if (this.socket && typeof this.socket.close === "function") {
        this.socket.close();
      } else if (this.isTor && this._torDgramSocket) {
        this._torDgramSocket.close();
      } else {
        this._onclose();
      }
    }
  }

  _unlinger() {
    if (this._timeout !== null) {
      clearTimeout(this._timeout);
      this._pool._lingering.delete(this);
      this._timeout = null;
    }
  }

  get free() {
    return this._refs === 0;
  }

  active() {
    this._refs++;
    this._unlinger();
  }

  inactive() {
    this._refs--;
    this._closeMaybe();
  }

  address() {
    if (!this.socket) {
      if (this.isTor && this._torDgramSocket && typeof this._torDgramSocket.address === "function") {
        return this._torDgramSocket.address();
      }
      return null;
    }
    return this.socket.address();
  }

  release() {
    if (this._released) return;

    this._released = true;
    this._reset();

    this._refs--;
    this._closeMaybe();
  }
}

function noop() {}
