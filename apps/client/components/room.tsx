"use client";

import { useEffect, useRef, useState } from "react";
import * as mediasoupClient from "mediasoup-client";
import type {
  Device,
  Transport,
  Consumer,
  RtpCapabilities,
} from "mediasoup-client/types";
import { generateUsername } from "unique-username-generator";
import RemoteVideo from "./remote";
import LocalVideo from "./local";

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
  const ws = useRef<WebSocket | null>(null);

  const peerId = useRef(`peer${Math.floor(Math.random() * 10000)}`);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([]);

  const device = useRef<Device | null>(null);
  const sendTransport = useRef<Transport | null>(null);
  const recvTransport = useRef<Transport | null>(null);

  const [displayName, setDisplayName] = useState<string>(generateUsername());
  const [isEditingName, setIsEditingName] = useState(false);
  const [isCameraOn, setIsCameraOn] = useState(true);
  const [isMicOn, setIsMicOn] = useState(true);

  const producer = useRef<any>(null);
  const consumers = useRef<Map<string, Consumer>>(new Map());

  const peers = useRef<Map<string, { consumers: Consumer[] }>>(new Map());
  const [remotePeerDisplayNames, setRemotePeerDisplayNames] = useState<{
    [peerId: string]: string;
  }>({});
  const [subscriptions, setSubscriptions] = useState<
    Record<string, { audio: boolean; video: boolean }>
  >({});

  const pendingRequests = useRef<
    Record<string, (response: ServerResponse) => void>
  >({});

  useEffect(() => {
    const socket = new WebSocket(
      `ws://localhost:8000?roomId=${roomId}&peerId=${peerId.current}`
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

  const setupSendTransport = async () => {
    if (device.current == null) return;

    const sendOptions = (await sendRequest("createWebRtcTransport", {})).data;
    sendTransport.current = device.current.createSendTransport({
      ...sendOptions,
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    sendTransport.current.on(
      "connect",
      ({ dtlsParameters }, callback, errback) => {
        sendRequest("connectWebRtcTransport", {
          transportId: sendOptions.id,
          dtlsParameters,
        })
          .then(callback)
          .catch(errback);
      }
    );

    sendTransport.current.on(
      "produce",
      ({ kind, rtpParameters }, callback, errback) => {
        sendRequest("produce", {
          transportId: sendOptions.id,
          kind,
          rtpParameters,
        })
          .then((res) => callback({ id: res.data.id }))
          .catch(errback);
      }
    );
  };

  const setupReceiveTransport = async () => {
    if (device.current == null) return;

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
  };

  const start = async () => {
    const routerCaps = await sendRequest("getRouterRtpCapabilities", {});
    const routerRtpCapabilities: RtpCapabilities = routerCaps.data;

    device.current = new mediasoupClient.Device();
    await device.current.load({ routerRtpCapabilities });

    const roomState = await sendRequest("join", {
      displayName: displayName,
      device: device.current.handlerName,
      rtpCapabilities: device.current.rtpCapabilities,
    });

    await setupSendTransport();
    await setupReceiveTransport();

    // Enable local audio and video producers using the same logic as toggles
    await enableMic();
    await enableWebcam();

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

      setSubscriptions((s) => ({
        ...s,
        [peerId]: { audio: true, video: true },
      }));
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

    await sendRequest("resumeConsumer", { consumerId: consumer.id });
  };

  const enableWebcam = async () => {
    if (!device.current || !sendTransport.current) return;
    if (producer.current && producer.current.video) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      const track = stream.getVideoTracks()[0];

      setLocalStream((prev) => {
        if (prev) {
          prev.getVideoTracks().forEach((t) => prev.removeTrack(t));
          prev.addTrack(track);
          return prev;
        }
        return stream;
      });

      const webcamProducer = await sendTransport.current.produce({
        track,
        encodings: [
          { rid: "r0", maxBitrate: 150_000, scaleResolutionDownBy: 4 }, // low
          { rid: "r1", maxBitrate: 500_000, scaleResolutionDownBy: 2 }, // mid
          { rid: "r2", maxBitrate: 1_200_000 }, // high
        ],
        codecOptions: {
          videoGoogleStartBitrate: 1000,
        },
      });
      producer.current = { ...producer.current, video: webcamProducer };
      setIsCameraOn(true);
      webcamProducer.on("trackended", () => {
        disableWebcam();
      });
      webcamProducer.on("transportclose", () => {
        disableWebcam();
      });
    } catch (err) {
      console.error("enableWebcam error", err);
    }
  };

  const disableWebcam = async () => {
    if (producer.current && producer.current.video) {
      try {
        producer.current.video.close();
        await sendRequest("closeProducer", {
          producerId: producer.current.video.id,
        });
      } catch (err) {
        console.error("disableWebcam error", err);
      }
      producer.current.video = null;
      setIsCameraOn(false);
    }
  };

  const toggleCamera = () => {
    if (producer.current && producer.current.video) {
      disableWebcam();
    } else {
      enableWebcam();
    }
  };

  const enableMic = async () => {
    if (!device.current || !sendTransport.current) return;
    if (producer.current && producer.current.audio) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];

      const micProducer = await sendTransport.current.produce({ track });
      producer.current = { ...producer.current, audio: micProducer };
      setIsMicOn(true);
      micProducer.on("trackended", () => {
        disableMic();
      });
      micProducer.on("transportclose", () => {
        disableMic();
      });
    } catch (err) {
      console.error("enableMic error", err);
    }
  };

  const disableMic = async () => {
    if (producer.current && producer.current.audio) {
      try {
        producer.current.audio.close();
        await sendRequest("closeProducer", {
          producerId: producer.current.audio.id,
        });
      } catch (err) {
        console.error("disableMic error", err);
      }
      producer.current.audio = null;
      setIsMicOn(false);
    }
  };

  const muteMic = async () => {
    if (producer.current && producer.current.audio) {
      try {
        await producer.current.audio.pause();
        await sendRequest("pauseProducer", {
          producerId: producer.current.audio.id,
        });
        setIsMicOn(false);
      } catch (err) {
        console.error("muteMic error", err);
      }
    }
  };

  const unmuteMic = async () => {
    if (producer.current && producer.current.audio) {
      try {
        await producer.current.audio.resume();
        await sendRequest("resumeProducer", {
          producerId: producer.current.audio.id,
        });
        setIsMicOn(true);
      } catch (err) {
        console.error("unmuteMic error", err);
      }
    }
  };

  const toggleMic = () => {
    if (producer.current && producer.current.audio) {
      if (producer.current.audio.paused) {
        unmuteMic();
      } else {
        muteMic();
      }
    } else {
      enableMic();
    }
  };

  const leaveRoom = () => {
    if (ws.current) {
      ws.current.close();
    }
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    // You can add navigation logic here
    window.location.reload();
  };

  const updateDisplayName = async (newName: string) => {
    await sendRequest("changeDisplayName", { displayName: newName.trim() });
  };

  function findConsumer(peerId: string, kind: "audio" | "video") {
    const peerData = peers.current.get(peerId);
    if (!peerData) return null;
    return peerData.consumers.find((c) => c.kind === kind) || null;
  }

  const toggleRemoteAudio = async (peerId: string) => {
    console.log("toggle audio peerid:", peerId);

    const sub = subscriptions[peerId] || { audio: true, video: true };
    const consumer = findConsumer(peerId, "audio");
    if (!consumer) return; // no audio to toggle

    if (sub.audio) {
      // Unsubscribe
      await sendRequest("pauseConsumer", { consumerId: consumer.id });
      consumer.pause();
    } else {
      // Resubscribe
      await sendRequest("resumeConsumer", { consumerId: consumer.id });
      consumer.resume();
    }

    setSubscriptions((s) => ({
      ...s,
      [peerId]: { ...s[peerId], audio: !sub.audio },
    }));
  };

  const toggleRemoteVideo = async (peerId: string) => {
    console.log("toggle video peerid:", peerId);

    const sub = subscriptions[peerId] || { audio: true, video: true };
    const consumer = findConsumer(peerId, "video");
    if (!consumer) return;

    if (sub.video) {
      // Hide (pause)
      await sendRequest("pauseConsumer", { consumerId: consumer.id });
      consumer.pause();
      // Optionally also remove track from stream so <RemoteVideo> shows “off”
      setRemoteStreams((rs) =>
        rs.map((r) => {
          if (r.peerId === peerId) {
            r.stream.getVideoTracks().forEach((t) => r.stream.removeTrack(t));
          }
          return r;
        })
      );
    } else {
      // Show (resume)
      await sendRequest("resumeConsumer", { consumerId: consumer.id });
      consumer.resume();
      // Re‑attach the track
      setRemoteStreams((rs) =>
        rs.map((r) => {
          if (r.peerId === peerId) {
            r.stream.addTrack(consumer.track);
          }
          return r;
        })
      );
    }

    setSubscriptions((s) => ({
      ...s,
      [peerId]: { ...s[peerId], video: !sub.video },
    }));
  };

  // Calculate grid layout
  const totalVideos = (localStream ? 1 : 0) + remoteStreams.length;
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
      <div className="flex-1 p-4 overflow-hidden">
        <div
          className="h-full w-full grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${gridCols}, 1fr)`,
            gridAutoRows: "minmax(0, 1fr)",
          }}
        >
          {localStream && (
            <LocalVideo
              stream={localStream}
              displayName={displayName}
              isCameraOn={isCameraOn}
            />
          )}
          {remoteStreams.map(({ id, stream, peerId }) => (
            <RemoteVideo
              key={id}
              peerId={peerId}
              displayName={remotePeerDisplayNames[peerId] ?? peerId}
              stream={stream}
              subscriptions={subscriptions}
              onToggleAudio={toggleRemoteAudio}
              onToggleVideo={toggleRemoteVideo}
            />
          ))}
        </div>
      </div>

      {/* Bottom toolbar */}
      <div className="bg-gray-800 p-4 flex items-center justify-between">
        {/* Left section - Room ID and Display Name */}

        {/* Left section - Room ID and Display Name */}
        <div className="flex items-center gap-4">
          <div className="text-white text-sm">
            <span className="text-gray-400">Room:</span> {roomId}
          </div>
          <div className="flex items-center gap-2">
            {isEditingName ? (
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => {
                  setIsEditingName(false);
                  updateDisplayName(displayName);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    setIsEditingName(false);
                    updateDisplayName(displayName);
                  }
                }}
                className="bg-gray-700 text-white px-2 py-1 rounded text-sm border border-gray-600 focus:border-blue-500 focus:outline-none"
                autoFocus
              />
            ) : (
              <button
                onClick={() => setIsEditingName(true)}
                className="text-white text-sm hover:text-blue-400 transition-colors"
              >
                <span className="text-gray-400">Name:</span> {displayName}
              </button>
            )}
          </div>
        </div>

        {/* Center section - Controls */}
        <div className="flex items-center gap-3">
          {/* Mic toggle */}
          <button
            onClick={toggleMic}
            className={`p-3 rounded-full transition-colors ${
              isMicOn
                ? "bg-gray-700 hover:bg-gray-600 text-white"
                : "bg-red-600 hover:bg-red-700 text-white"
            }`}
            title={isMicOn ? "Mute microphone" : "Unmute microphone"}
          >
            {isMicOn ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z"
                  clipRule="evenodd"
                />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M2.22 2.22a.75.75 0 011.06 0L6.54 5.48A3.001 3.001 0 0110 4v4c0 .18-.02.35-.05.52l2.58 2.58c.24-.37.42-.8.47-1.27V8a1 1 0 112 0v1.83c0 1.04-.2 2.03-.57 2.94l1.42 1.42a.75.75 0 11-1.06 1.06L2.22 3.28a.75.75 0 010-1.06zM7 8v.17L9.17 10.5c.01-.06.01-.11.01-.17V8a1 1 0 00-2.18 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </button>

          {/* Camera toggle */}
          <button
            onClick={toggleCamera}
            className={`p-3 rounded-full transition-colors ${
              isCameraOn
                ? "bg-gray-700 hover:bg-gray-600 text-white"
                : "bg-red-600 hover:bg-red-700 text-white"
            }`}
            title={isCameraOn ? "Turn off camera" : "Turn on camera"}
          >
            {isCameraOn ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path d="M2 6a2 2 0 012-2h6a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6zM14.553 7.106A1 1 0 0014 8v4a1 1 0 00.553.894l2 1A1 1 0 0018 13V7a1 1 0 00-1.447-.894l-2 1z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M3.28 2.22a.75.75 0 00-1.06 1.06l14.5 14.5a.75.75 0 101.06-1.06L3.28 2.22zM6.31 5.37L4.5 3.56A2 2 0 004 4v8a2 2 0 002 2h6c.37 0 .7-.1.99-.27L9.69 10.5H6V6.31zM14 8.5V7a1 1 0 00-1.447-.894L11 6.5v1.69l3 3V8.5z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </button>

          {/* Leave button */}
          <button
            onClick={leaveRoom}
            className="p-3 rounded-full bg-red-600 hover:bg-red-700 text-white transition-colors"
            title="Leave room"
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M3 3a1 1 0 00-1 1v12a1 1 0 102 0V4a1 1 0 00-1-1zm10.293 9.293a1 1 0 001.414 1.414l3-3a1 1 0 000-1.414l-3-3a1 1 0 10-1.414 1.414L14.586 9H7a1 1 0 100 2h7.586l-1.293 1.293z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Right section - Additional info */}
        <div className="text-gray-400 text-sm">
          {totalVideos} participant{totalVideos !== 1 ? "s" : ""}
        </div>
      </div>
    </div>
  );
}
