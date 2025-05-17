const HyperDHT = require("./index.js");
const b4a = require("b4a");

async function runTest() {
  console.log("Starting Tor DHT test...");

  const torOptions = {
    tor: true,
  };

  console.log("Creating DHT Instance A (Server)...");
  const dhtA = new HyperDHT(torOptions);
  await dhtA.ready();
  console.log("DHT Instance A ready. Public key:", dhtA.defaultKeyPair.publicKey.toString("hex"));

  console.log("Creating DHT Instance B (Client)...");
  const dhtB = new HyperDHT(torOptions);
  await dhtB.ready();
  console.log("DHT Instance B ready. Public key:", dhtB.defaultKeyPair.publicKey.toString("hex"));

  const topic = HyperDHT.hash(b4a.from("my-secret-topic-over-tor"));
  const keyPairA = dhtA.defaultKeyPair;

  console.log(`\n[DHT A] Announcing on topic: ${topic.toString("hex")}`);
  const server = dhtA.createServer(async (connection) => {
    console.log("[DHT A] Received incoming connection over Tor!");
    connection.on("data", (data) => {
      console.log(`[DHT A] Received data from client: ${data.toString()}`);
      connection.write(b4a.from(`Pong: ${data.toString()}`));
    });
    connection.on("error", (err) => console.error("[DHT A] Server connection error:", err));
    connection.on("close", () => console.log("[DHT A] Server connection closed"));
  });

  await server.listen(keyPairA);
  console.log(`[DHT A] Listening on its public key: ${keyPairA.publicKey.toString("hex")}`);

  console.log("[Test] Waiting a few seconds for announcement to propagate...");
  await new Promise((resolve) => setTimeout(resolve, 15000));

  console.log(`\n[DHT B] Looking up peers for server's public key: ${keyPairA.publicKey.toString("hex")}`);
  try {
    console.log(`[DHT B] Attempting to connect to DHT A (${keyPairA.publicKey.toString("hex")}) over Tor...`);
    const socket = dhtB.connect(keyPairA.publicKey);

    socket.on("open", () => {
      console.log("[DHT B] Connection to DHT A established over Tor!");
      socket.write(b4a.from("Hello from DHT B over Tor!"));
    });

    socket.on("data", (data) => {
      console.log(`[DHT B] Received data from server: ${data.toString()}`);
      socket.end();
    });

    socket.on("error", (err) => {
      console.error("[DHT B] Client connection error:", err);
    });

    socket.on("close", async () => {
      console.log("[DHT B] Client connection closed.");
      console.log("\n[Test] Test sequence finished. Cleaning up...");
      await server.close();
      await dhtA.destroy();
      await dhtB.destroy();
      console.log("[Test] Cleanup complete.");
    });
  } catch (err) {
    console.error("[DHT B] Error during connect/lookup phase:", err);
    console.log("\n[Test] Test sequence failed. Cleaning up...");
    await server.close();
    await dhtA.destroy();
    await dhtB.destroy();
    console.log("[Test] Cleanup complete.");
  }
}

runTest().catch((err) => {
  console.error("Unhandled error in test:", err);
  process.exit(1);
});
