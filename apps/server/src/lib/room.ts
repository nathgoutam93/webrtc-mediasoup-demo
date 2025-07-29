import { EventEmitter } from "events";
import {
  Router,
  TransportListenInfo,
  WebRtcServer,
  Worker,
} from "mediasoup/types";
import Peer from "./peer.js";
import { config } from "../config.js";
import WebSocket from "ws";

class Room extends EventEmitter {
  id: string;
  peers: Map<string, Peer>;
  worker: Worker;

  private _mediasoupRouter: Router | null;
  private _webRtcServer: WebRtcServer | null;

  // Make constructor private to force async creation
  private constructor(roomId: string, worker: Worker) {
    super();
    this.id = roomId;
    this.peers = new Map();
    this.worker = worker;
    this._mediasoupRouter = null;
    this._webRtcServer = worker.appData.webRtcServer as WebRtcServer;
  }

  // Static async factory method
  static async create(roomId: string, worker: Worker): Promise<Room> {
    const room = new Room(roomId, worker);
    await room.init();
    return room;
  }

  async init() {
    const { mediaCodecs } = config.mediasoup.routerOptions;
    this._mediasoupRouter = await this.worker.createRouter({ mediaCodecs });
  }

  createPeer(peerId: string, transport: WebSocket): Peer {
    if (this.peers.has(peerId)) {
      throw new Error(`Peer ${peerId} already exists`);
    }

    const peer = new Peer(peerId, transport);
    this.peers.set(peerId, peer);
    return peer;
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  hasPeer(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  getPeer(peerId: string): Peer | undefined {
    return this.peers.get(peerId);
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
    this.emit("peerLeft", peerId);
  }

  broadcast(
    method: string,
    data: unknown,
    excludeId: string | null = null
  ): void {
    for (const [id, peer] of this.peers.entries()) {
      if (id !== excludeId) {
        peer.notify(method, data);
      }
    }
  }

  async handlePeerRequest(peer: Peer, req: any): Promise<void> {
    const { id, method, data } = req;

    try {
      switch (method) {
        case "getRouterRtpCapabilities":
          if (!this._mediasoupRouter) throw new Error("Router not ready");
          peer.respond(id, true, this._mediasoupRouter.rtpCapabilities);
          break;

        case "join":
          if (!peer.data) peer.data = {};
          if (peer.data.joined) throw new Error("Peer already joined");
          const { displayName, device, rtpCapabilities } = data;
          peer.data.joined = true;
          peer.data.displayName = displayName;
          peer.data.device = device;
          peer.data.rtpCapabilities = rtpCapabilities;
          this.broadcast(
            "newPeer",
            { id: peer.id, displayName, device },
            peer.id
          );
          const peerInfos = Array.from(this.peers.values())
            .filter(
              (p) =>
                p.id !== peer.id &&
                p.data &&
                p.data.displayName &&
                p.data.device
            )
            .map((p) => ({
              id: p.id,
              producerId:
                p.data.producers && p.data.producers.size > 0
                  ? Array.from(p.data.producers as Map<string, unknown>)[0][0]
                  : null,
              displayName: p.data.displayName,
              device: p.data.device,
            }));
          peer.respond(id, true, { peers: peerInfos });
          break;

        case "createWebRtcTransport":
          if (!this._mediasoupRouter) throw new Error("Router not ready");
          const { forceTcp } = data;
          const webRtcTransportOptions = {
            ...JSON.parse(
              JSON.stringify(config.mediasoup.webRtcTransportOptions)
            ),
            webRtcServer: this._webRtcServer,
            iceConsentTimeout: 20,
          };
          if (forceTcp) {
            webRtcTransportOptions.listenIPs =
              webRtcTransportOptions.listenIPs.filter(
                (listenInfo: TransportListenInfo) =>
                  listenInfo.protocol === "tcp"
              );
            webRtcTransportOptions.enableUdp = false;
            webRtcTransportOptions.enableTcp = true;
          }
          const transport = await this._mediasoupRouter.createWebRtcTransport(
            webRtcTransportOptions
          );

          console.log(transport.iceCandidates);

          transport.on("icestatechange", (state) => {
            console.log("ICE state:", state);
          });
          transport.on("dtlsstatechange", (state) => {
            console.log("DTLS state:", state);
          });

          console.log("Transport created:", {
            id: transport.id,
            dtlsState: transport.dtlsState,
            iceState: transport.iceState,
            iceSelectedTuple: transport.iceSelectedTuple,
          });

          if (!peer.data.transports) peer.data.transports = new Map();
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
          if (!peer.data.transports) throw new Error("No transports");
          const { transportId, dtlsParameters } = data;
          const transportConn = peer.data.transports.get(transportId);
          if (!transportConn)
            throw new Error(`transport with id "${transportId}" not found`);
          await transportConn.connect({ dtlsParameters });
          peer.respond(id, true, {});
          break;

        case "produce":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.transports) throw new Error("No transports");
          if (!peer.data.producers) peer.data.producers = new Map();
          const { transportId: prodTransportId, kind, rtpParameters } = data;
          const transportProd = peer.data.transports.get(prodTransportId);
          if (!transportProd)
            throw new Error(`transport with id "${prodTransportId}" not found`);
          const producer = await transportProd.produce({
            kind,
            rtpParameters,
            appData: { peerId: peer.id },
          });
          peer.data.producers.set(producer.id, producer);

          console.log(
            "Producer created:",
            producer.id,
            producer.kind,
            "paused:",
            producer.paused
          );

          this.broadcast(
            "newProducer",
            { peerId: peer.id, displayName: peer.data.displayName , producerId: producer.id, kind },
            peer.id
          );
          peer.respond(id, true, { id: producer.id });
          break;

        case "closeProducer":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.producers) throw new Error("No producers");
          const { producerId } = data;
          const producerToClose = peer.data.producers.get(producerId);
          if (!producerToClose)
            throw new Error(`producer with id "${producerId}" not found`);
          producerToClose.close();
          peer.data.producers.delete(producerToClose.id);
          peer.respond(id, true, {});
          break;

        case "consume":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.transports) throw new Error("No transports");
          if (!peer.data.consumers) peer.data.consumers = new Map();
          const {
            producerId: consumeProducerId,
            rtpCapabilities: consumerRtpCapabilities,
            transportId: consumeTransportId,
          } = data;
          const producerToConsume = (() => {
            for (const p of this.peers.values()) {
              if (
                p.data &&
                p.data.producers &&
                p.data.producers.has(consumeProducerId)
              ) {
                return p.data.producers.get(consumeProducerId);
              }
            }
            return null;
          })();
          if (!producerToConsume)
            throw new Error(
              `Producer with id "${consumeProducerId}" not found`
            );
          const transportToConsume =
            peer.data.transports.get(consumeTransportId);
          if (!transportToConsume)
            throw new Error(
              `Transport with id "${consumeTransportId}" not found`
            );
          if (!this._mediasoupRouter) throw new Error("Router not ready");
          if (
            !this._mediasoupRouter.canConsume({
              producerId: consumeProducerId,
              rtpCapabilities: consumerRtpCapabilities,
            })
          ) {
            throw new Error(
              "Cannot consume this producer with given rtpCapabilities"
            );
          }
          const consumer = await transportToConsume.consume({
            producerId: consumeProducerId,
            rtpCapabilities: consumerRtpCapabilities,
            paused: false,
            appData: { peerId: peer.id },
          });
          peer.data.consumers.set(consumer.id, consumer);

          console.log("[consume] Consumer created:", {
            id: consumer.id,
            kind: consumer.kind,
            paused: consumer.paused,
            producerPaused: consumer.producerPaused,
          });

          consumer.on("producerclose", () => {
            peer.notify("consumerClosed", { consumerId: consumer.id });
            peer.data.consumers.delete(consumer.id);
          });
          consumer.on("score", (score: any) => {
            console.log("[consume] Consumer score:", score);
          });
          consumer.on("trace", (trace: any) => {
            console.log("[consume] Trace:", trace);
          });
          consumer.on("transportclose", () => {
            console.log(
              "[consume] Transport closed for consumer:",
              consumer.id
            );
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
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.consumers) throw new Error("No consumers");
          const { consumerId } = data;
          const consumerToClose = peer.data.consumers.get(consumerId);
          if (!consumerToClose)
            throw new Error(`consumer with id "${consumerId}" not found`);
          consumerToClose.close();
          peer.data.consumers.delete(consumerId);
          peer.respond(id, true, {});
          break;

        case "pauseProducer":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.producers) throw new Error("No producers");
          const { producerId: pauseProducerId2 } = data;
          const pauseProducer = peer.data.producers.get(pauseProducerId2);
          if (!pauseProducer)
            throw new Error(`producer with id "${pauseProducerId2}" not found`);
          await pauseProducer.pause();
          peer.respond(id, true, {});
          break;

        case "resumeProducer":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.producers) throw new Error("No producers");
          const { producerId: resumeProducerId2 } = data;
          const resumeProducer = peer.data.producers.get(resumeProducerId2);
          if (!resumeProducer)
            throw new Error(
              `producer with id "${resumeProducerId2}" not found`
            );
          await resumeProducer.resume();
          peer.respond(id, true, {});
          break;

        case "pauseConsumer":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.consumers) throw new Error("No consumers");
          const { consumerId: pauseConsumerId2 } = data;
          const pauseConsumer = peer.data.consumers.get(pauseConsumerId2);
          if (!pauseConsumer)
            throw new Error(`consumer with id "${pauseConsumerId2}" not found`);
          await pauseConsumer.pause();
          peer.respond(id, true, {});
          break;

        case "resumeConsumer":
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          if (!peer.data.consumers) throw new Error("No consumers");
          const { consumerId: resumeConsumerId2 } = data;
          const resumeConsumer = peer.data.consumers.get(resumeConsumerId2);
          if (!resumeConsumer)
            throw new Error(
              `consumer with id "${resumeConsumerId2}" not found`
            );
          await resumeConsumer.resume();
          peer.respond(id, true, {});
          break;

        case "changeDisplayName": 
          if (!peer.data.joined) throw new Error("Peer not yet joined");
          peer.data.displayName = data.displayName;
          this.broadcast("peerDisplayNameChanged", {
            peerId: peer.id,
            displayName: peer.data.displayName,
          }, peer.id);
          break;
    
        default:
          console.error('unknown request.method "%s"', method);
          peer.respond(id, false, "Unknown method");
          return;
      }
    } catch (err: any) {
      console.error(`Error handling request from ${peer.id}:`, err);
      peer.respond(id, false, err.message || "Internal server error");
    }
  }

  handlePeerNotification(peer: Peer, note: any): void {
    console.log(`Notification from ${peer.id}: ${note.method}`);
    // Optional: Add custom handling here
  }

  async handlePeerConnection(peerId: string, ws: WebSocket): Promise<Peer> {
    if (this.hasPeer(peerId)) {
      throw new Error(
        `Peer with ID "${peerId}" already exists in room "${this.id}"`
      );
    }

    const peer = this.createPeer(peerId, ws);

    peer.onRequest = async (req) => {
      await this.handlePeerRequest(peer, req);
    };

    peer.onNotification = (note) => {
      this.handlePeerNotification(peer, note);
    };

    ws.on("close", () => {
      this.removePeer(peerId);
      this.broadcast("peerLeft", { peerId }, peerId);

      if (this.isEmpty()) {
        this.close();
      }
    });

    this.broadcast("newPeer", { peerId }, peerId);
    this.emit("peerJoined", peer);

    return peer;
  }

  close(): void {
    if (this._mediasoupRouter) {
      this._mediasoupRouter.close();
      this._mediasoupRouter = null;
    }
    this.emit("close");
  }
}

export default Room;
