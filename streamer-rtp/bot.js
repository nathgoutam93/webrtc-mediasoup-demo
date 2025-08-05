import WebSocket from "ws";
import fs from "fs";
import { spawn } from "child_process";
import path from "path";
import { randomUUID } from "crypto";

const BASE_PORT = 5000;
const SDP_FILE = "/tmp/multi.sdp";
const HLS_OUT_DIR = "/tmp/hls";
const ROOM_ID = "test-room";
const PEER_ID = `bot-${Math.floor(Math.random() * 9999)}`;

let pendingRequests = {};
let producers = [];
let producerPortMap = new Map();
let ffmpegProcess = null;
let ws;
let nextPort = BASE_PORT;

/**
 * Send a request to the SFU and wait for the response
 */
function sendRequest(ws, method, data) {
  return new Promise((resolve) => {
    const id = randomUUID();
    pendingRequests[id] = resolve;
    ws.send(JSON.stringify({ request: true, id, method, data }));
  });
}

/**
 * Allocate an RTP port (and RTCP port if needed)
 */
function allocatePortPair() {
  const rtpPort = nextPort;
  const rtcpPort = nextPort + 1;
  nextPort += 2;
  return { rtpPort, rtcpPort };
}

/**
 * Create plain RTP consumers for all current producers
 */
async function setupConsumers() {
  producerPortMap.clear();
  nextPort = BASE_PORT;

  for (const p of producers) {
    const { rtpPort, rtcpPort } = allocatePortPair();

    const { data } = await sendRequest(ws, "createPlainConsumer", {
      producerId: p.id,
      ip: "127.0.0.1",
      port: rtpPort,
      rtcpPort,
      paused: false,
    });

    const { producerId, kind, payloadType, codec } = data;

    producerPortMap.set(producerId, {
      kind,
      rtpPort,
      rtcpPort,
      codec,
      payloadType,
    });

    console.log(
      `Consumer for ${p.kind} producer ${p.id} (${p.codec}/${p.payloadType}) on port ${rtpPort}`
    );
  }
}

/**
 * Generate an SDP file for FFmpeg
 */
function generateSDP() {
  let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup MultiTrack
t=0 0
`;

  for (const [
    producerId,
    { kind, rtpPort, rtcpPort, codec, payloadType },
  ] of producerPortMap) {
    if (!rtpPort || !rtcpPort || !codec || !payloadType) continue;

    // Clock rate depends on kind
    const clockRate = kind === "audio" ? 48000 : 90000;

    // m-line
    sdp += `m=${kind} ${rtpPort} RTP/AVP ${payloadType}
c=IN IP4 127.0.0.1
a=rtpmap:${payloadType} ${codec}/${clockRate}`;

    // For Opus, stereo flag
    if (kind === "audio" && codec.toLowerCase() === "opus") {
      sdp += `/2`;
    }
    sdp += `
a=sendonly
a=rtcp:${rtcpPort} IN IP4 127.0.0.1
`;

    // VP8 extra fmtp for compatibility
    if (kind === "video" && codec.toLowerCase() === "vp8") {
      sdp += `a=fmtp:${payloadType} max-fr=30;max-fs=12288
`;
    }
  }

  fs.writeFileSync(SDP_FILE, sdp);
  console.log(`✅ SDP file written for rtcpMux:false: ${SDP_FILE}`);
}

function requestKeyframes() {
  const interval = setInterval(() => {
    for (const [id, { kind }] of producerPortMap) {
      if (kind === "video") {
        sendRequest(ws, "requestKeyframe", { producerId: id });
      }
    }
  }, 500);

  setTimeout(() => clearInterval(interval), 5000);
}

/**
 * Start FFmpeg process
 */
function startFFmpeg() {
  if (!fs.existsSync(HLS_OUT_DIR)) {
    fs.mkdirSync(HLS_OUT_DIR, { recursive: true });
  }

  const videoProducers = [...producerPortMap.values()].filter(
    (v) => v.kind === "video"
  );
  const audioProducers = [...producerPortMap.values()].filter(
    (v) => v.kind === "audio"
  );

  let filter = "";
  videoProducers.forEach((vp, i) => {
    filter += `[${i}:v]scale=640:360[v${i}];`;
  });

  const numVideos = videoProducers.length;
  const gridCols = Math.ceil(Math.sqrt(numVideos));
  const gridRows = Math.ceil(numVideos / gridCols);

  let layout = [];
  let x = 0,
    y = 0;
  for (let i = 0; i < numVideos; i++) {
    layout.push(`${x * 640}_${y * 360}`);
    x++;
    if (x >= gridCols) {
      x = 0;
      y++;
    }
  }

  if (numVideos > 0) {
    filter += `${Array.from({ length: numVideos }, (_, i) => `[v${i}]`).join(
      ""
    )}xstack=inputs=${numVideos}:layout=${layout.join("|")}[vout]`;
  }

  const ffmpegArgs = [
    "-protocol_whitelist",
    "file,udp,rtp",
    "-analyzeduration",
    "100M",
    "-probesize",
    "100M",
    "-i",
    SDP_FILE,
    ...(numVideos > 0 ? ["-filter_complex", filter, "-map", "[vout]"] : []),
    ...(audioProducers.length > 0 ? ["-map", `${numVideos}:a:0`] : []),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    ...(audioProducers.length > 0 ? ["-c:a", "aac", "-b:a", "128k"] : []),
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_list_size",
    "6",
    "-hls_flags",
    "delete_segments",
    path.join(HLS_OUT_DIR, "index.m3u8"),
  ];

  console.log("Starting FFmpeg:", ffmpegArgs.join(" "));
  ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

  ffmpegProcess.stdout.on("data", (d) => console.log(`FFmpeg: ${d}`));
  ffmpegProcess.stderr.on("data", (d) => console.error(`FFmpeg err: ${d}`));
  ffmpegProcess.on("close", (code) => console.log(`FFmpeg exited: ${code}`));
}

/**
 * Stop FFmpeg if running
 */
function stopFFmpeg() {
  if (ffmpegProcess) {
    ffmpegProcess.kill("SIGKILL");
    ffmpegProcess = null;
  }
}

/**
 * Refresh pipeline when producers change
 */
async function refreshPipeline() {
  stopFFmpeg();
  await setupConsumers();

  // Find first video and first audio producer IDs
  const firstVideo = [...producerPortMap.entries()].find(
    ([id, p]) => p.kind === "video"
  )?.[0];
  const firstAudio = [...producerPortMap.entries()].find(
    ([id, p]) => p.kind === "audio"
  )?.[0];

  // Generate SDP for just that pair
  generateSingleSDP(firstVideo, firstAudio);

  // Start FFmpeg for single pair

  setTimeout(() => {
    startSingleFFmpeg();
    requestKeyframes();
  }, 2000);

  // generateSDP();
  // setTimeout(() => {
  //   startFFmpeg();
  // }, 2000);
}

/**
 * Generate SDP for a single video + audio pair
 */
function generateSingleSDP(videoProducerId, audioProducerId) {
  let sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup SingleTrack
t=0 0
`;

  function addTrack(p) {
    if (!p) return;
    const clockRate = p.kind === "audio" ? 48000 : 90000;
    sdp += `m=${p.kind} ${p.rtpPort} RTP/AVP ${p.payloadType}
c=IN IP4 127.0.0.1
a=rtpmap:${p.payloadType} ${p.codec}/${clockRate}`;
    if (p.kind === "audio" && p.codec.toLowerCase() === "opus") {
      sdp += `/2`;
    }
    sdp += `
a=sendonly
a=rtcp:${p.rtcpPort} IN IP4 127.0.0.1
`;
    if (p.kind === "video" && p.codec.toLowerCase() === "vp8") {
      sdp += `a=fmtp:${p.payloadType} max-fr=30;max-fs=12288
`;
    }
  }

  addTrack(producerPortMap.get(videoProducerId));
  addTrack(producerPortMap.get(audioProducerId));

  fs.writeFileSync(SDP_FILE, sdp);
  console.log(`✅ Single SDP file written: ${SDP_FILE}`);
}

/**
 * Start FFmpeg for a single video/audio pair
 */
function startSingleFFmpeg() {
  if (!fs.existsSync(HLS_OUT_DIR)) {
    fs.mkdirSync(HLS_OUT_DIR, { recursive: true });
  }

  const ffmpegArgs = [
    "-protocol_whitelist",
    "file,udp,rtp",
    "-analyzeduration",
    "100M",
    "-probesize",
    "100M",
    "-i",
    SDP_FILE,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    "4",
    "-hls_list_size",
    "6",
    "-hls_flags",
    "delete_segments",
    path.join(HLS_OUT_DIR, "index.m3u8"),
  ];

  console.log("Starting single FFmpeg:", ffmpegArgs.join(" "));
  ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

  ffmpegProcess.stdout.on("data", (d) => console.log(`FFmpeg: ${d}`));
  ffmpegProcess.stderr.on("data", (d) => console.error(`FFmpeg err: ${d}`));
  ffmpegProcess.on("close", (code) => console.log(`FFmpeg exited: ${code}`));
}

/**
 * WebSocket setup
 */
ws = new WebSocket(`ws://localhost:8000?roomId=${ROOM_ID}&peerId=${PEER_ID}`);

ws.on("open", async () => {
  console.log("Connected to SFU signaling");

  await sendRequest(ws, "joinPlain", {});

  const { ok, data } = await sendRequest(ws, "listProducers", {});
  if (!ok) return;
  producers = data;
  console.log("Got producers:", producers);

  await refreshPipeline();
});

ws.on("message", async (msg) => {
  const data = JSON.parse(msg);

  // Match request/response
  if (data.id && pendingRequests[data.id]) {
    pendingRequests[data.id](data);
    delete pendingRequests[data.id];
    return;
  }

  // Handle unsolicited events
  if (data.notification === "newProducer") {
    console.log("New producer:", data.producer);
    producers.push(data.producer);
    await refreshPipeline();
  } else if (data.notification === "producerClosed") {
    console.log("Producer closed:", data.producerId);
    producers = producers.filter((p) => p.id !== data.producerId);
    await refreshPipeline();
  }
});

ws.on("error", (er) => {
  console.error(er);
});

ws.on("close", () => {
  console.log("WebSocket closed");
  stopFFmpeg();
});
