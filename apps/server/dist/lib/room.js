import { config } from "../config.js";
import { EventEmitter } from "events";
import Peer from "./peer.js";
class Room extends EventEmitter {
    id;
    peers;
    worker;
    _mediasoupRouter;
    _nextPort = 50000;
    _plainExports = new Map();
    // Make constructor private to force async creation
    constructor(roomId, worker) {
        super();
        this.id = roomId;
        this.peers = new Map();
        this.worker = worker;
        this._mediasoupRouter = null;
    }
    static async create(roomId, worker) {
        const room = new Room(roomId, worker);
        await room.init();
        return room;
    }
    async init() {
        const { mediaCodecs } = config.mediasoup.routerOptions;
        this._mediasoupRouter = await this.worker.createRouter({ mediaCodecs });
    }
    get router() {
        if (!this._mediasoupRouter)
            throw new Error("Router not ready");
        return this._mediasoupRouter;
    }
    get nextRtpPort() {
        this._nextPort += 2;
        if (this._nextPort > 60000)
            this._nextPort = 50000;
        return this._nextPort;
    }
    createPeer(peerId, transport) {
        if (this.peers.has(peerId)) {
            console.error(`Peer ${peerId} already exists`);
            return null;
        }
        const peer = new Peer(peerId, transport);
        this.peers.set(peerId, peer);
        return peer;
    }
    isEmpty() {
        return this.peers.size === 0;
    }
    hasPeer(peerId) {
        return this.peers.has(peerId);
    }
    getPeer(peerId) {
        return this.peers.get(peerId);
    }
    removePeer(peerId) {
        const peer = this.peers.get(peerId);
        if (!peer)
            return;
        if (peer.data.transports) {
            for (const transport of peer.data.transports.values()) {
                transport.close();
            }
        }
        this.peers.delete(peerId);
        this.emit("peerLeft", peerId);
        if (this.isEmpty()) {
            this.close();
        }
    }
    broadcast(method, data, excludeId = null) {
        for (const [id, peer] of this.peers.entries()) {
            if (id !== excludeId) {
                peer.notify(method, data);
            }
        }
    }
    async handlePeerRequest(peer, req) {
        const { id, method, data } = req;
        try {
            switch (method) {
                case "getRouterRtpCapabilities":
                    if (!this._mediasoupRouter)
                        throw new Error("Router not ready");
                    peer.respond(id, true, this._mediasoupRouter.rtpCapabilities);
                    break;
                case "join":
                    if (!peer.data)
                        peer.data = {};
                    if (peer.data.joined)
                        throw new Error("Peer already joined");
                    const { displayName, device, rtpCapabilities } = data;
                    peer.data.joined = true;
                    peer.data.displayName = displayName;
                    peer.data.device = device;
                    peer.data.rtpCapabilities = rtpCapabilities;
                    this.broadcast("newPeer", { id: peer.id, displayName, device }, peer.id);
                    const peerInfos = Array.from(this.peers.values())
                        .filter((p) => p.id !== peer.id && p.data.joined)
                        .map((p) => ({
                        id: p.id,
                        displayName: p.data.displayName,
                        device: p.data.device,
                        producers: p.data.producers
                            ? Array.from(p.data.producers.values()).map((pr) => ({
                                id: pr.id,
                                kind: pr.kind,
                            }))
                            : [],
                    }));
                    peer.respond(id, true, { peers: peerInfos });
                    break;
                case "createWebRtcTransport":
                    if (!this._mediasoupRouter)
                        throw new Error("Router not ready");
                    const { forceTcp } = data;
                    const webRtcTransportOptions = {
                        ...JSON.parse(JSON.stringify(config.mediasoup.webRtcTransportOptions)),
                        iceConsentTimeout: 20,
                    };
                    if (forceTcp) {
                        webRtcTransportOptions.listenIPs =
                            webRtcTransportOptions.listenIPs.filter((listenInfo) => listenInfo.protocol === "tcp");
                        webRtcTransportOptions.enableUdp = false;
                        webRtcTransportOptions.enableTcp = true;
                    }
                    const transport = await this._mediasoupRouter.createWebRtcTransport(webRtcTransportOptions);
                    transport.on("icestatechange", (iceState) => {
                        console.warn('WebRtcTransport "icestatechange" event [iceState:%s]', iceState);
                        if (iceState === "disconnected" || iceState === "closed") {
                            peer.close();
                        }
                    });
                    transport.on("dtlsstatechange", (dtlsState) => {
                        console.log('WebRtcTransport "dtlsstatechange" event [dtlsState:%s]', dtlsState);
                        if (dtlsState === "failed" || dtlsState === "closed") {
                            peer.close();
                        }
                    });
                    if (!peer.data.transports)
                        peer.data.transports = new Map();
                    peer.data.transports.set(transport.id, transport);
                    peer.respond(id, true, {
                        id: transport.id,
                        iceParameters: transport.iceParameters,
                        iceCandidates: transport.iceCandidates,
                        dtlsParameters: transport.dtlsParameters,
                        sctpParameters: transport.sctpParameters,
                    });
                    break;
                case "connectWebRtcTransport":
                    if (!peer.data.transports)
                        throw new Error("No transports");
                    const { transportId, dtlsParameters } = data;
                    const transportConn = peer.data.transports.get(transportId);
                    if (!transportConn)
                        throw new Error(`transport with id "${transportId}" not found`);
                    await transportConn.connect({ dtlsParameters });
                    peer.respond(id, true, {});
                    break;
                case "produce":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.transports)
                        throw new Error("No transports");
                    if (!peer.data.producers)
                        peer.data.producers = new Map();
                    const { transportId: prodTransportId, kind, rtpParameters } = data;
                    const transportProd = peer.data.transports.get(prodTransportId);
                    if (!transportProd)
                        throw new Error(`transport with id "${prodTransportId}" not found`);
                    const producer = await transportProd.produce({
                        kind,
                        rtpParameters,
                        appData: { peerId: peer.id, roomId: this.id },
                    });
                    peer.data.producers.set(producer.id, producer);
                    producer.on("score", (score) => {
                        console.log('producer "score" event [producerId:%s, score:%o]', producer.id, score);
                        this.broadcast("producerScore", {
                            peerId: peer.id,
                            score,
                        });
                    });
                    this.broadcast("newProducer", {
                        peerId: peer.id,
                        displayName: peer.data.displayName,
                        producerId: producer.id,
                        kind,
                    }, peer.id);
                    peer.respond(id, true, { id: producer.id });
                    break;
                case "closeProducer":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.producers)
                        throw new Error("No producers");
                    const { producerId } = data;
                    const producerToClose = peer.data.producers.get(producerId);
                    if (!producerToClose)
                        throw new Error(`producer with id "${producerId}" not found`);
                    producerToClose.close();
                    peer.data.producers.delete(producerToClose.id);
                    this.broadcast("producerClosed", { producerId: producerToClose.id, peerId: peer.id }, peer.id);
                    // find related plain export(s), close transport/consumer and delete from cache
                    for (const [key, rec] of this._plainExports.entries()) {
                        if (rec.producerId === producerId) {
                            rec.consumer.close();
                            rec.transport.close();
                            this._plainExports.delete(key);
                        }
                    }
                    peer.respond(id, true, {});
                    break;
                case "consume":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.transports)
                        throw new Error("No transports");
                    if (!peer.data.consumers)
                        peer.data.consumers = new Map();
                    const { producerId: consumeProducerId, rtpCapabilities: consumerRtpCapabilities, transportId: consumeTransportId, } = data;
                    const producerToConsume = (() => {
                        for (const p of this.peers.values()) {
                            if (p.data &&
                                p.data.producers &&
                                p.data.producers.has(consumeProducerId)) {
                                return p.data.producers.get(consumeProducerId);
                            }
                        }
                        return null;
                    })();
                    if (!producerToConsume)
                        throw new Error(`Producer with id "${consumeProducerId}" not found`);
                    const transportToConsume = peer.data.transports.get(consumeTransportId);
                    if (!transportToConsume)
                        throw new Error(`Transport with id "${consumeTransportId}" not found`);
                    if (!this._mediasoupRouter)
                        throw new Error("Router not ready");
                    if (!this._mediasoupRouter.canConsume({
                        producerId: consumeProducerId,
                        rtpCapabilities: consumerRtpCapabilities,
                    })) {
                        throw new Error("Cannot consume this producer with given rtpCapabilities");
                    }
                    const consumer = await transportToConsume.consume({
                        producerId: consumeProducerId,
                        rtpCapabilities: consumerRtpCapabilities,
                        paused: false,
                        appData: { peerId: peer.id },
                    });
                    await consumer.setPreferredLayers({
                        spatialLayer: 0,
                        temporalLayer: 0,
                    });
                    // setTimeout(async () => {
                    //   await consumer.setPreferredLayers({
                    //     spatialLayer: 2,
                    //     temporalLayer: 2,
                    //   });
                    // }, 1000 * 60);
                    peer.data.consumers.set(consumer.id, consumer);
                    // console.log("[consume] Consumer created:", {
                    //   id: consumer.id,
                    //   kind: consumer.kind,
                    //   paused: consumer.paused,
                    //   producerPaused: consumer.producerPaused,
                    // });
                    consumer.on("producerclose", () => {
                        peer.notify("consumerClosed", { consumerId: consumer.id });
                        peer.data.consumers.delete(consumer.id);
                    });
                    peer.respond(id, true, {
                        id: consumer.id,
                        producerId: consumeProducerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                        type: consumer.type,
                        producerPaused: consumer.producerPaused,
                    });
                    break;
                case "closeConsumer":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.consumers)
                        throw new Error("No consumers");
                    const { consumerId } = data;
                    const consumerToClose = peer.data.consumers.get(consumerId);
                    if (!consumerToClose)
                        throw new Error(`consumer with id "${consumerId}" not found`);
                    consumerToClose.close();
                    peer.data.consumers.delete(consumerId);
                    peer.respond(id, true, {});
                    break;
                case "pauseProducer":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.producers)
                        throw new Error("No producers");
                    const { producerId: pauseProducerId2 } = data;
                    const pauseProducer = peer.data.producers.get(pauseProducerId2);
                    if (!pauseProducer)
                        throw new Error(`producer with id "${pauseProducerId2}" not found`);
                    await pauseProducer.pause();
                    this.broadcast("producerPaused", { producerId: pauseProducer.id, peerId: peer.id }, peer.id);
                    peer.respond(id, true, {});
                    break;
                case "resumeProducer":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.producers)
                        throw new Error("No producers");
                    const { producerId: resumeProducerId2 } = data;
                    const resumeProducer = peer.data.producers.get(resumeProducerId2);
                    if (!resumeProducer)
                        throw new Error(`producer with id "${resumeProducerId2}" not found`);
                    await resumeProducer.resume();
                    this.broadcast("producerResumed", { producerId: resumeProducer.id, peerId: peer.id }, peer.id);
                    peer.respond(id, true, {});
                    break;
                case "pauseConsumer":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.consumers)
                        throw new Error("No consumers");
                    const { consumerId: pauseConsumerId2 } = data;
                    const pauseConsumer = peer.data.consumers.get(pauseConsumerId2);
                    if (!pauseConsumer)
                        throw new Error(`consumer with id "${pauseConsumerId2}" not found`);
                    await pauseConsumer.pause();
                    peer.respond(id, true, {});
                    break;
                case "resumeConsumer":
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!peer.data.consumers)
                        throw new Error("No consumers");
                    const { consumerId: resumeConsumerId2 } = data;
                    const resumeConsumer = peer.data.consumers.get(resumeConsumerId2);
                    if (!resumeConsumer)
                        throw new Error(`consumer with id "${resumeConsumerId2}" not found`);
                    await resumeConsumer.resume();
                    peer.respond(id, true, {});
                    break;
                case "changeDisplayName": {
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    const { displayName } = data;
                    peer.data.displayName = displayName;
                    this.broadcast("peerDisplayNameChanged", {
                        peerId: peer.id,
                        displayName: peer.data.displayName,
                    }, peer.id);
                    break;
                }
                // ONLY USE BY BOTS
                case "joinPlain": {
                    if (!peer.data)
                        peer.data = {};
                    if (peer.data.joined)
                        throw new Error("Peer already joined");
                    const { displayName } = data;
                    peer.data.joined = true;
                    peer.data.displayName = displayName || peer.id;
                    peer.data.isPlainBot = true;
                    peer.respond(id, true, { ok: true });
                    break;
                }
                case "listProducers":
                    if (!this._mediasoupRouter)
                        throw new Error("Router not ready");
                    const allProducers = [];
                    for (const p of this.peers.values()) {
                        if (p.data?.producers) {
                            for (const prod of p.data.producers.values()) {
                                allProducers.push({
                                    id: prod.id,
                                    kind: prod.kind,
                                    codec: prod.rtpParameters.codecs[0].mimeType.split("/")[1],
                                    payloadType: prod.rtpParameters.codecs[0].payloadType,
                                });
                            }
                        }
                    }
                    peer.respond(id, true, allProducers);
                    break;
                case "createPlainConsumer": {
                    if (!peer.data.joined)
                        throw new Error("Peer not yet joined");
                    if (!this._mediasoupRouter)
                        throw new Error("Router not ready");
                    const { producerId, port, rtcpPort, ip } = data;
                    if (!port || !ip)
                        throw new Error("did not provide UDP port or IP");
                    const receiverIp = ip;
                    const receiverPort = port;
                    const receiverRtcpPort = rtcpPort;
                    // find producer
                    const producer = (() => {
                        for (const p of this.peers.values()) {
                            if (p.data?.producers?.has(producerId)) {
                                return p.data.producers.get(producerId);
                            }
                        }
                        return null;
                    })();
                    if (!producer)
                        throw new Error(`Producer ${producerId} not found`);
                    // create plain transport
                    const transport = await this._mediasoupRouter.createPlainTransport(config.mediasoup.plainTransportOptions);
                    await transport.connect({
                        ip: receiverIp,
                        port: receiverPort,
                        rtcpPort: receiverRtcpPort, // <-- missing in your SFU code now
                    });
                    // consumer
                    const consumer = await transport.consume({
                        producerId: producer.id,
                        paused: false,
                        rtpCapabilities: this._mediasoupRouter.rtpCapabilities,
                    });
                    await consumer.resume();
                    if (consumer.kind === "video") {
                        const interval = setInterval(() => {
                            consumer.requestKeyFrame();
                        }, 500); // every 500ms
                        setTimeout(() => clearInterval(interval), 2000); // for 2s
                    }
                    // store and respond
                    if (!peer.data.transports)
                        peer.data.transports = new Map();
                    peer.data.transports.set(transport.id, transport);
                    if (!peer.data.consumers)
                        peer.data.consumers = new Map();
                    peer.data.consumers.set(consumer.id, consumer);
                    this._plainExports.set(consumer.id, {
                        producerId: producer.id,
                        transport,
                        consumer,
                    });
                    const codec = producer.rtpParameters.codecs[0];
                    peer.respond(id, true, {
                        producerId,
                        kind: consumer.kind,
                        rtpParameters: consumer.rtpParameters,
                        payloadType: codec.payloadType,
                        codec: codec.mimeType.split("/")[1],
                    });
                    break;
                }
                case "requestKeyframe": {
                    const { producerId } = data;
                    let found = false;
                    for (const p of this.peers.values()) {
                        if (p.data?.consumers) {
                            for (const consumer of p.data.consumers.values()) {
                                if (consumer.producerId === producerId &&
                                    consumer.kind === "video") {
                                    console.log(`Requesting keyframe for consumer ${consumer.id}`);
                                    await consumer.resume();
                                    await consumer.requestKeyFrame();
                                    found = true;
                                }
                            }
                        }
                    }
                    if (!found) {
                        peer.respond(id, false, `No consumer found for producer ${producerId}`);
                    }
                    peer.respond(id, true, `keyframe requested`);
                    break;
                }
                case "resumePlainConsumer": {
                    const { producerId } = data;
                    for (const p of this.peers.values()) {
                        if (p.data?.consumers) {
                            for (const consumer of p.data.consumers.values()) {
                                if (consumer.producerId === producerId) {
                                    await consumer.resume();
                                    console.log(`Consumer resumed: ${consumer.id}`);
                                }
                            }
                        }
                    }
                    peer.respond(id, true, "consumer resumed");
                    break;
                }
                case "closePlainConsumer": {
                    const { producerId } = data;
                    const entry = [...this._plainExports.values()].find((e) => e.producerId === producerId);
                    if (entry) {
                        entry.consumer.close();
                        entry.transport.close();
                        this._plainExports.delete([...this._plainExports.keys()].find((k) => this._plainExports.get(k) === entry));
                    }
                    peer.respond(id, true, {});
                    break;
                }
                default:
                    console.error('unknown request.method "%s"', method);
                    peer.respond(id, false, "Unknown method");
                    return;
            }
        }
        catch (err) {
            console.error(`Error handling request from ${peer.id}:`, err);
            peer.respond(id, false, err.message || "Internal server error");
        }
    }
    handlePeerNotification(peer, note) {
        console.log(`Notification from ${peer.id}: ${note.method}`);
        // Optional: Add custom handling here
    }
    async handlePeerConnection(peerId, ws) {
        if (this.hasPeer(peerId)) {
            console.error(`Peer with ID "${peerId}" already exists in room "${this.id}"`);
            return null;
        }
        const peer = this.createPeer(peerId, ws);
        if (!peer) {
            ws.close(1011, "Peer creation failed");
            return null;
        }
        peer.onRequest = async (req) => {
            await this.handlePeerRequest(peer, req);
        };
        peer.onNotification = (note) => {
            this.handlePeerNotification(peer, note);
        };
        ws.on("close", () => {
            this.removePeer(peerId);
            this.broadcast("peerLeft", { peerId }, peerId);
        });
        this.broadcast("newPeer", { peerId }, peerId);
        this.emit("peerJoined", peer);
        return peer;
    }
    close() {
        if (this._mediasoupRouter) {
            this._mediasoupRouter.close();
            this._mediasoupRouter = null;
        }
        this.emit("close");
    }
}
export default Room;
//# sourceMappingURL=room.js.map