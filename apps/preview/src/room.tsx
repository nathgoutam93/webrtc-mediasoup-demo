import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import type {
  Device,
  Transport,
  Consumer,
  RtpCapabilities,
} from "mediasoup-client/types";

type ServerRequest = {
  id: string;
  request: true;
  method: string;
  data: any;
};

type ServerResponse = {
  id: string;
  data: any;
};

type ServerNotification = {
  method: string;
  data: any;
};

type RemoteStream = {
  id: string;
  peerId: string;
  stream: MediaStream;
};

type ExistingPeer = {
  id: string;
  displayName: string;
  device: string;
  producers: { id: string; kind: string }[];
};

export default function Room({ roomId }: { roomId: string }) {
  const host = window.location.hostname;
  const ws = useRef<WebSocket | null>(null);

  const peerId = useRef(`peer${Math.floor(Math.random() * 10000)}`);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);

  const device = useRef<Device | null>(null);
  const recvTransport = useRef<Transport | null>(null);

  const consumers = useRef<Map<string, Consumer>>(new Map());
  const peers = useRef<Map<string, { consumers: Consumer[] }>>(new Map());

  const [remotePeerDisplayNames, setRemotePeerDisplayNames] = useState<{
    [peerId: string]: string;
  }>({});

  const pendingRequests = useRef<
    Record<string, (response: ServerResponse) => void>
  >({});

  useEffect(() => {
    document.querySelectorAll("video").forEach((v) => {
      v.muted = false;
      v.play().catch(console.error);
    });
  }, [remoteStreams]);

  useEffect(() => {
    const socket = new WebSocket(
      `ws://${host}:8000?roomId=${roomId}&peerId=${peerId.current}`
    );
    ws.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connected");
      setTimeout(start, 500);
    };

    socket.onmessage = async (event) => {
      const msg = JSON.parse(event.data);

      if (msg.id && pendingRequests.current[msg.id]) {
        pendingRequests.current[msg.id](msg);
        delete pendingRequests.current[msg.id];
      } else if (msg.method) {
        const notification = msg as ServerNotification;
        if (notification.method === "newProducer") {
          const { producerId, peerId } = notification.data;
          await consume(producerId, peerId);
        } else if (notification.method === "peerDisplayNameChanged") {
          const { peerId, displayName } = notification.data;
          setRemotePeerDisplayNames((prev) => ({
            ...prev,
            [peerId]: displayName,
          }));
          const prevConsumers = peers.current.get(peerId)?.consumers ?? [];
          peers.current.set(peerId, { consumers: prevConsumers });
        } else if (notification.method === "producerClosed") {
          const { producerId, peerId } = notification.data;

          // find the Consumer consuming that producer
          const consumer = Array.from(consumers.current.values()).find(
            (c) => c.producerId === producerId
          );
          if (!consumer) return;

          // close & remove it
          consumer.close();
          consumers.current.delete(consumer.id);
          peers.current.get(peerId)!.consumers = peers.current
            .get(peerId)!
            .consumers.filter((c) => c.id !== consumer.id);

          // strip video track out of the MediaStream
          setRemoteStreams((prev) =>
            prev.map((s) => {
              if (s.peerId !== peerId) return s;
              s.stream.getVideoTracks().forEach((t) => s.stream.removeTrack(t));
              return s;
            })
          );
        } else if (notification.method === "peerLeft") {
          const leftPeerId = notification.data.peerId;
          const peerData = peers.current.get(leftPeerId);
          if (peerData) {
            for (const consumer of peerData.consumers) {
              consumer.close();
              consumers.current.delete(consumer.id);
            }
            // Remove the entire remote stream for this peer
            setRemoteStreams((prev) =>
              prev.filter((s) => s.peerId !== leftPeerId)
            );
            peers.current.delete(leftPeerId);
          }
        }
      }
    };

    return () => {
      socket.close();
    };
  }, []);

  const sendRequest = (method: string, data: any): Promise<ServerResponse> => {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).substr(2, 9);
      pendingRequests.current[id] = resolve;
      const req: ServerRequest = { id, request: true, method, data };
      ws.current?.send(JSON.stringify(req));
    });
  };

  const start = async () => {
    const routerCaps = await sendRequest("getRouterRtpCapabilities", {});
    const routerRtpCapabilities: RtpCapabilities = routerCaps.data;

    device.current = new mediasoupClient.Device();
    await device.current.load({ routerRtpCapabilities });

    const roomState = await sendRequest("join", {
      displayName: peerId,
      device: device.current.handlerName,
      rtpCapabilities: device.current.rtpCapabilities,
    });

    const recvOptions = (await sendRequest("createWebRtcTransport", {})).data;
    recvTransport.current = device.current.createRecvTransport({
      ...recvOptions,
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    recvTransport.current.on(
      "connect",
      ({ dtlsParameters }, callback, errback) => {
        sendRequest("connectWebRtcTransport", {
          transportId: recvOptions.id,
          dtlsParameters,
        })
          .then(callback)
          .catch(errback);
      }
    );

    const existingPeers: ExistingPeer[] = roomState.data.peers || [];
    for (const peer of existingPeers) {
      setRemotePeerDisplayNames((d) => ({ ...d, [peer.id]: peer.displayName }));
      for (const prod of peer.producers) {
        await consume(prod.id, peer.id);
      }
    }
  };

  const consume = async (producerId: string, peerId: string) => {
    if (!device.current || !recvTransport.current) return;

    const { data } = await sendRequest("consume", {
      producerId,
      rtpCapabilities: device.current.rtpCapabilities,
      transportId: recvTransport.current.id,
    });

    const consumer = await recvTransport.current.consume({
      id: data.id,
      producerId: data.producerId,
      kind: data.kind,
      rtpParameters: data.rtpParameters,
    });

    consumers.current.set(consumer.id, consumer);

    if (peerId) {
      if (!peers.current.has(peerId)) {
        peers.current.set(peerId, { consumers: [] });
      }

      const oldData = peers.current.get(peerId);
      if (oldData) {
        peers.current.set(peerId, {
          ...oldData,
          consumers: [...oldData.consumers, consumer],
        });
      }
    }

    setRemoteStreams((prev) => {
      // Find if we already have a RemoteStream for this peer
      const existing = prev.find((s) => s.peerId === peerId);
      if (existing) {
        // Add the new track to the existing MediaStream
        if (
          !existing.stream.getTracks().some((t) => t.id === consumer.track.id)
        ) {
          existing.stream.addTrack(consumer.track);
        }
        return [...prev]; // trigger rerender
      } else {
        // Create a new stream for this peer
        const stream = new MediaStream([consumer.track]);
        return [...prev, { id: peerId, peerId, stream }];
      }
    });
  };

  // Calculate grid layout
  const totalVideos = remoteStreams.length;
  const getGridCols = (count: number) => {
    if (count <= 1) return 1;
    if (count <= 4) return 2;
    if (count <= 9) return 3;
    if (count <= 16) return 4;
    return 5;
  };

  const gridCols = getGridCols(totalVideos);

  return (
    <div className="w-full h-screen bg-gray-900 relative flex flex-col">
      {/* Main video area */}
      <div className="flex-1 p-4 overflow-hidden relative">
        {remoteStreams.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-2xl font-medium bg-gray-800 rounded-lg">
            Stream not started yet
          </div>
        )}

        <div
          className="h-full w-full grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
            gridAutoRows: "minmax(0, 1fr)",
            visibility: remoteStreams.length === 0 ? "hidden" : "visible",
          }}
        >
          {remoteStreams.map(({ id, stream, peerId }) => (
            <RemoteVideo
              key={id}
              peerId={peerId}
              displayName={remotePeerDisplayNames[peerId] ?? peerId}
              stream={stream}
            />
          ))}
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="bg-gray-800 p-4 flex items-center justify-between">
        {/* Left section */}
        <div className="flex items-center gap-4">
          <div className="text-white text-sm">
            <span className="text-gray-400">Room:</span> {roomId}
          </div>
        </div>

        {/* Right section */}
        <div className="text-gray-400 text-sm">
          {totalVideos} participant{totalVideos !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}

function RemoteVideo({
  peerId,
  displayName,
  stream,
}: {
  peerId: string;
  displayName: string;
  stream: MediaStream;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const isCameraOn = stream.getVideoTracks().length > 0;

  useEffect(() => {
    console.log(stream.getTracks());

    const videoEl = ref.current;
    if (!videoEl || !stream) return;

    if (videoEl.srcObject !== stream) {
      videoEl.srcObject = stream;
    }

    videoEl.muted = false; // ✅ always unmute
    videoEl.play().catch((err) => console.error("Video play error:", err));
  }, [stream]);

  return (
    <div className="relative w-full h-full bg-gray-800 rounded-lg overflow-hidden isolate">
      <video
        ref={ref}
        autoPlay
        playsInline
        className="relative w-full h-full object-cover"
        style={{ display: isCameraOn ? "block" : "none" }}
      />
      {!isCameraOn && (
        <div className="w-full h-full flex items-center justify-center bg-gray-700">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-gray-500 flex items-center justify-center mx-auto mb-2 text-3xl text-white font-bold">
              {displayName?.[0]?.toUpperCase() || "?"}
            </div>
            <p className="text-gray-400 text-sm">Camera off</p>
          </div>
        </div>
      )}
      <div className="absolute bottom-2 left-2 bg-black bg-opacity-70 text-white px-2 py-1 rounded text-xs font-medium">
        {displayName ?? peerId}
      </div>
    </div>
  );
}
