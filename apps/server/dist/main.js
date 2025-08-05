import "dotenv/config";
import { config } from "./config.js";
import url from "url";
import http from "http";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createWorker, observer } from "mediasoup";
import { WebSocketServer } from "ws";
import { AwaitQueue } from "awaitqueue";
import Room from "./lib/room.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// const rootPath = resolve(__dirname, "../../..");
const queue = new AwaitQueue();
let httpServer;
let expressApp;
let webSocketServer;
const mediasoupWorkers = [];
let nextMediasoupWorkerIdx = 0;
const rooms = new Map();
const workers = new Map();
const webRtcServers = new Map();
const routers = new Map();
const transports = new Map();
const producers = new Map();
const consumers = new Map();
run();
async function run() {
    runMediasoupObserver();
    await runMediasoupWorkers();
    await createExpressApp();
    await runHttpsServer();
    await runWebSocketServer();
}
async function createExpressApp() {
    expressApp = express();
    expressApp.use(cors());
    expressApp.use(bodyParser.json());
    expressApp.use("/preview", express.static(join(__dirname, "..", "public", "preview")));
    expressApp.use("/live", express.static("/tmp/hls"));
}
async function runHttpsServer() {
    console.info("running HTTPS server...");
    httpServer = http.createServer(expressApp);
    await new Promise((resolve, _) => {
        httpServer.listen(Number(config.http.listenPort), config.http.listenIp, () => resolve(`listening on port ${Number(config.http.listenPort)}`));
    });
}
async function runWebSocketServer() {
    console.info("running WebSocketServer...");
    webSocketServer = new WebSocketServer({ server: httpServer });
    webSocketServer.on("connection", (ws, req) => {
        const { query } = url.parse(req.url, true);
        const roomId = query.roomId;
        const peerId = query.peerId;
        if (!roomId || !peerId) {
            ws.close(1008, "Missing roomId or peerId");
            return;
        }
        queue.push(async () => {
            const room = await getOrCreateRoom({ roomId: roomId });
            await room.handlePeerConnection(peerId.toString(), ws);
        });
    });
}
function runMediasoupObserver() {
    observer.on("newworker", (worker) => {
        // Store the latest worker in a global variable.
        global.worker = worker;
        workers.set(worker.pid, worker);
        worker.observer.on("close", () => workers.delete(worker.pid));
        worker.observer.on("newwebrtcserver", (webRtcServer) => {
            // Store the latest webRtcServer in a global variable.
            global.webRtcServer = webRtcServer;
            webRtcServers.set(webRtcServer.id, webRtcServer);
            webRtcServer.observer.on("close", () => webRtcServers.delete(webRtcServer.id));
        });
        worker.observer.on("newrouter", (router) => {
            // Store the latest router in a global variable.
            global.router = router;
            routers.set(router.id, router);
            router.observer.on("close", () => routers.delete(router.id));
            router.observer.on("newtransport", (transport) => {
                // Store the latest transport in a global variable.
                global.transport = transport;
                transports.set(transport.id, transport);
                transport.observer.on("close", () => transports.delete(transport.id));
                transport.observer.on("newproducer", async (producer) => {
                    // Store the latest producer in a global variable.
                    global.producer = producer;
                    producers.set(producer.id, producer);
                    producer.observer.on("close", async () => {
                        producers.delete(producer.id);
                    });
                });
                transport.observer.on("newconsumer", (consumer) => {
                    // Store the latest consumer in a global variable.
                    global.consumer = consumer;
                    consumers.set(consumer.id, consumer);
                    consumer.observer.on("close", () => consumers.delete(consumer.id));
                });
            });
        });
    });
}
async function runMediasoupWorkers() {
    const { numWorkers } = config.mediasoup;
    console.info("running %d mediasoup Workers...", numWorkers);
    for (let i = 0; i < numWorkers; ++i) {
        const worker = await createWorker({
            dtlsCertificateFile: config.mediasoup.workerSettings.dtlsCertificateFile,
            dtlsPrivateKeyFile: config.mediasoup.workerSettings.dtlsPrivateKeyFile,
            logLevel: config.mediasoup.workerSettings.logLevel,
            logTags: config.mediasoup.workerSettings.logTags,
            rtcMinPort: Number(config.mediasoup.workerSettings.rtcMinPort),
            rtcMaxPort: Number(config.mediasoup.workerSettings.rtcMaxPort),
            disableLiburing: Boolean(config.mediasoup.workerSettings.disableLiburing),
        });
        worker.on("died", () => {
            console.error("mediasoup Worker died, exiting  in 5 seconds... [pid:%d]", worker.pid);
            setTimeout(() => process.exit(1), 5000);
        });
        mediasoupWorkers.push(worker);
        if (process.env.MEDIASOUP_USE_WEBRTC_SERVER !== "false") {
            const webRtcServerOptions = JSON.parse(JSON.stringify(config.mediasoup.webRtcServerOptions));
            const portIncrement = mediasoupWorkers.length - 1;
            for (const listenInfo of webRtcServerOptions.listenInfos) {
                listenInfo.port += portIncrement;
            }
            const webRtcServer = await worker.createWebRtcServer(webRtcServerOptions);
            worker.appData.webRtcServer = webRtcServer;
        }
    }
}
function getMediasoupWorker() {
    const worker = mediasoupWorkers[nextMediasoupWorkerIdx % mediasoupWorkers.length];
    nextMediasoupWorkerIdx++;
    return worker;
}
async function getOrCreateRoom({ roomId }) {
    let room = rooms.get(roomId);
    if (!room) {
        console.info("creating a new Room [roomId:%s]", roomId);
        const mediasoupWorker = getMediasoupWorker();
        room = await Room.create(roomId, mediasoupWorker);
        rooms.set(roomId, room);
        // startStreamForRoom(roomId);
        room.on("peerJoined", (peer) => {
            console.log(`peer joind emit:: ${peer}`);
        });
        room.on("close", () => {
            console.log(`Room [${roomId}] closed`);
            rooms.delete(roomId);
        });
    }
    return room;
}
//# sourceMappingURL=main.js.map