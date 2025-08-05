import WebSocket from "ws";
import fs from "fs";
import { spawn } from "child_process";
import { join } from "path";

const peerId = "bot-" + Math.floor(Math.random() * 9999);
const roomId = "test-room";
const ws = new WebSocket(`ws://localhost:8000?roomId=${roomId}&peerId=${peerId}`);

const producersMap = new Map(); // producerId → { kind, rtpParameters }
const knownProducers = new Set(); // avoid duplicate consumers

// Known SDP file path
const sdpFile = process.platform === "win32"
    ? "C:/temp/mediasoup-bot.sdp"
    : "/tmp/mediasoup-bot.sdp";

// HLS output directory
const hlsDir = process.platform === "win32"
    ? "C:/temp/hls"
    : "/tmp/hls/";
const outDir = join(hlsDir, roomId);
fs.mkdirSync(outDir, { recursive: true });

let ffmpegProcess = null;

ws.on("open", () => {
    console.log("✅ Bot connected to server");
    sendRequest("joinPlain", { displayName: "Bot" });
    listProducers();
    setInterval(listProducers, 3000);
});

function sendRequest(method, data) {
    const id = Math.floor(Math.random() * 999999);
    ws.send(JSON.stringify({ request: true, id, method, data }));
}

function listProducers() {
    sendRequest("listProducers", {});
}

function handleNewConsumer(producerId, kind, rtpParameters) {
    producersMap.set(producerId, { kind, rtpParameters });

    console.log(`🆕 Got params for ${kind} producer ${producerId}`);
    regenerateSDP();

    // Resume consumer first, then request keyframe
    sendRequest("resumePlainConsumer", { producerId });
    if (kind === "video") {
        setTimeout(() => {
            sendRequest("requestKeyframe", { producerId });
        }, 200);
    }

    // Start FFmpeg only when both tracks available
    if (!ffmpegProcess && hasRequiredTracks()) {
        startFFmpeg();
    }
}

function hasRequiredTracks() {
    const kinds = [...producersMap.values()].map(p => p.kind);
    return kinds.includes("video") && kinds.includes("audio");
}

ws.on("message", (msg) => {
    const data = JSON.parse(msg.toString());

    // Producer list
    if (data.response && data.ok && Array.isArray(data.data)) {
        for (const prod of data.data) {
            if (!knownProducers.has(prod.id)) {
                knownProducers.add(prod.id);
                console.log(`🎯 New ${prod.kind} producer: ${prod.id}`);
                createPlainConsumer(prod.id, prod.kind);
            }
        }
    }

    // Consumer parameters
    if (data.response && data.ok && data.data?.rtpParameters) {
        handleNewConsumer(
            data.data.producerId,
            data.data.kind,
            data.data.rtpParameters
        );
    }
});

function createPlainConsumer(producerId, kind) {
    const basePort = kind === "audio" ? 6000 : 5006; // separate RTP ports

    sendRequest("createPlainConsumer", {
        producerId,
        port: basePort,
        ip: "127.0.0.1",
        paused: true,
        rtcpMux: true // IMPORTANT: avoid needing extra RTCP port
    });
}

function regenerateSDP() {
    let sdp = "v=0\n";
    sdp += "o=- 0 0 IN IP4 127.0.0.1\n";
    sdp += "s=Mediasoup RTP\n";
    sdp += "t=0 0\n";

    for (const { kind, rtpParameters } of producersMap.values()) {
        const port = kind === "audio" ? 6000 : 5006;
        const payloadTypes = rtpParameters.codecs.map(c => c.payloadType).join(" ");
        sdp += `m=${kind} ${port} RTP/AVP ${payloadTypes}\n`;
        sdp += "c=IN IP4 127.0.0.1\n";
        sdp += "a=recvonly\n"; // ensure FFmpeg knows we only receive
        sdp += "a=rtcp-mux\n"; // RTCP-mux enabled

        for (const codec of rtpParameters.codecs) {
            sdp += `a=rtpmap:${codec.payloadType} ${codec.mimeType.split("/")[1]}/${codec.clockRate}`;
            if (codec.channels && codec.channels > 1) {
                sdp += `/${codec.channels}`;
            }
            sdp += "\n";

            if (codec.parameters && Object.keys(codec.parameters).length) {
                const fmtp = Object.entries(codec.parameters)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(";");
                sdp += `a=fmtp:${codec.payloadType} ${fmtp}\n`;
            }
        }

        const ssrc = rtpParameters.encodings?.[0]?.ssrc;
        if (ssrc) {
            sdp += `a=ssrc:${ssrc} cname:stream\n`;
        }
    }

    fs.writeFileSync(sdpFile, sdp);
    console.log(`✅ SDP written with ${producersMap.size} tracks → ${sdpFile}`);
}

function startFFmpeg() {
    console.log("🎬 Starting FFmpeg for HLS output");

    const ffmpegArgs = [
        "-protocol_whitelist", "file,udp,rtp",
        "-i", sdpFile,

        // Video encoding
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-x264opts", "keyint=60:min-keyint=60:scenecut=0",

        // Audio encoding
        "-c:a", "aac",
        "-ar", "48000",
        "-b:a", "128k",

        // HLS settings
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "6",
        "-hls_flags", "delete_segments+append_list+program_date_time",

        `${outDir}/stream.m3u8`
    ];

    ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

    ffmpegProcess.stdout.on("data", (d) => console.log("ffmpeg:", d.toString()));
    ffmpegProcess.stderr.on("data", (d) => console.error("ffmpeg:", d.toString()));

    ffmpegProcess.on("close", (code) => {
        console.log(`FFmpeg exited with code ${code}`);
        ffmpegProcess = null;
    });
}
