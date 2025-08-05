import { writeFile, mkdir } from "fs/promises";
import { spawn } from "child_process";
import path from "path";
import { randomUUID } from "crypto";
function buildFmtpString(codec) {
    const parts = [];
    const name = (codec.mimeType || "").split("/")[1] || "";
    if (name.toUpperCase() === "H264") {
        if (codec.parameters["packetization-mode"] !== undefined)
            parts.push(`packetization-mode=${codec.parameters["packetization-mode"]}`);
        if (codec.parameters["profile-level-id"])
            parts.push(`profile-level-id=${codec.parameters["profile-level-id"]}`);
        if (codec.parameters["sprop-parameter-sets"])
            parts.push(`sprop-parameter-sets=${codec.parameters["sprop-parameter-sets"]}`);
    }
    else {
        for (const [k, v] of Object.entries(codec.parameters || {})) {
            parts.push(`${k}=${v}`);
        }
    }
    return parts.join(";");
}
function buildSdpForConsumer(consumer, rtpPort, rtcpPort, rtcpMux) {
    const isVideo = consumer.kind === "video";
    const codec = consumer.rtpParameters.codecs[0];
    if (!codec)
        throw new Error("No codec in consumer.rtpParameters");
    const payloadType = codec.payloadType;
    const mime = codec.mimeType; // e.g., "video/VP8" or "audio/opus"
    const [type, name] = mime.split("/");
    const lines = [
        "v=0",
        `o=- ${randomUUID()} 1 IN IP4 127.0.0.1`,
        "s=mixed",
        "c=IN IP4 127.0.0.1",
        "t=0 0",
    ];
    if (isVideo) {
        lines.push(`m=video ${rtpPort} RTP/AVP ${payloadType}`);
        if (!rtcpMux) {
            lines.push(`a=rtcp:${rtcpPort}`);
        }
        else {
            lines.push("a=rtcp-mux");
        }
        lines.push(`a=rtpmap:${payloadType} ${name}/90000`);
        const fmtp = buildFmtpString(codec);
        if (fmtp)
            lines.push(`a=fmtp:${payloadType} ${fmtp}`);
        // optional SSRC line
        const ssrc = consumer.rtpParameters.encodings?.[0]?.ssrc;
        if (ssrc) {
            const cname = `mixed-${randomUUID().slice(0, 8)}`;
            lines.push(`a=ssrc:${ssrc} cname:${cname}`);
        }
        lines.push("a=control:streamid=0");
        lines.push("a=sendrecv");
    }
    else {
        let clockRate = 48000;
        let channels = 2;
        if (codec.clockRate)
            clockRate = codec.clockRate;
        if (codec.channels)
            channels = codec.channels;
        lines.push(`m=audio ${rtpPort} RTP/AVP ${payloadType}`);
        if (!rtcpMux) {
            lines.push(`a=rtcp:${rtcpPort}`);
        }
        else {
            lines.push("a=rtcp-mux");
        }
        lines.push(`a=rtpmap:${payloadType} ${name}/${clockRate}${channels > 1 ? `/${channels}` : ""}`);
        const fmtp = buildFmtpString(codec);
        if (fmtp)
            lines.push(`a=fmtp:${payloadType} ${fmtp}`);
        const ssrc = consumer.rtpParameters.encodings?.[0]?.ssrc;
        if (ssrc) {
            const cname = `mixed-${randomUUID().slice(0, 8)}`;
            lines.push(`a=ssrc:${ssrc} cname:${cname}`);
        }
        lines.push("a=control:streamid=1");
        lines.push("a=sendrecv");
    }
    return lines.join("\r\n") + "\r\n";
}
function getCreatePlainTransportFn(router) {
    if (typeof router.createPlainTransport === "function") {
        return router.createPlainTransport.bind(router);
    }
    if (typeof router.createPlainRtpTransport === "function") {
        return router.createPlainRtpTransport.bind(router);
    }
    return null;
}
class PortAllocator {
    cursor;
    constructor(start) {
        this.cursor = start;
    }
    nextRtp() {
        return this.cursor++;
    }
    nextRtcp() {
        return this.cursor++;
    }
}
function startRequestingKeyframes(consumer, intervalMs = 2000) {
    if (consumer.kind !== "video" || typeof consumer.requestKeyFrame !== "function") {
        console.warn("Cannot request keyframe; consumer not video or method missing");
        return () => { };
    }
    const iv = setInterval(() => {
        consumer.requestKeyFrame().catch((e) => {
            console.warn("requestKeyFrame failed:", e);
        });
    }, intervalMs);
    return () => clearInterval(iv);
}
async function consumeProducer(router, producer, portAllocator, outputDir, createPlainFn) {
    const kind = producer.kind === "video" ? "video" : "audio";
    const useRtcpMux = true; // recommend true for simpler feedback/keyframe flow
    const plainTransport = await createPlainFn({
        listenIp: "127.0.0.1",
        rtcpMux: useRtcpMux,
        comedia: false,
        enableSctp: false,
    });
    const rtpPort = portAllocator.nextRtp();
    const rtcpPort = useRtcpMux ? undefined : portAllocator.nextRtcp();
    if (useRtcpMux) {
        await plainTransport.connect({
            ip: "127.0.0.1",
            port: rtpPort,
        });
    }
    else {
        await plainTransport.connect({
            ip: "127.0.0.1",
            port: rtpPort,
            rtcpPort,
        });
    }
    const canConsume = await router.canConsume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
    });
    if (!canConsume) {
        try {
            plainTransport.close();
        }
        catch { }
        return null;
    }
    const consumer = await plainTransport.consume({
        producerId: producer.id,
        rtpCapabilities: router.rtpCapabilities,
        paused: false,
        appData: { for: "mixed-hls" },
    });
    const stopKeyframes = startRequestingKeyframes(consumer, 2000);
    const sdp = buildSdpForConsumer(consumer, rtpPort, useRtcpMux ? 0 : rtcpPort, useRtcpMux);
    const sdpPath = path.join(outputDir, `input_${producer.id}.sdp`);
    await writeFile(sdpPath, sdp);
    return {
        producer,
        transport: plainTransport,
        consumer,
        kind,
        sdpPath,
        stopKeyframes
    };
}
function buildVideoFilterComplex(videoInputs, layoutWidth, layoutHeight) {
    const parts = [];
    if (videoInputs.length === 0) {
        parts.push(`nullsrc=size=${layoutWidth}x${layoutHeight},format=yuv420p[mixedVideo]`);
        return parts;
    }
    if (videoInputs.length === 1) {
        const inputIdx = videoInputs[0].inputIndex;
        parts.push(`[${inputIdx}:v]scale=${layoutWidth}:${layoutHeight},setsar=1,format=yuv420p[mixedVideo]`);
        return parts;
    }
    const numVideos = videoInputs.length;
    const cols = Math.ceil(Math.sqrt(numVideos));
    const rows = Math.ceil(numVideos / cols);
    const tileW = Math.floor(layoutWidth / cols);
    const tileH = Math.floor(layoutHeight / rows);
    // 1. Scale each real video input to tile size.
    const scaledLabels = [];
    videoInputs.forEach((v, idx) => {
        const inputIdx = v.inputIndex;
        const label = `vscaled${idx}`;
        parts.push(`[${inputIdx}:v]scale=${tileW}:${tileH},setsar=1[${label}]`);
        scaledLabels.push(label);
    });
    // 2. Pad with nullsrc if grid has empty cells.
    const gridSize = cols * rows;
    const padCount = gridSize - numVideos;
    const fillerLabels = [];
    for (let i = 0; i < padCount; i++) {
        const fillLabel = `fill${i}`;
        // nullsrc produces a black frame of the right size
        parts.push(`nullsrc=size=${tileW}x${tileH},setsar=1,format=yuv420p[${fillLabel}]`);
        fillerLabels.push(fillLabel);
    }
    // 3. Build layout string: for each cell in row-major, compute x_y
    const layoutCoordinates = [];
    for (let cell = 0; cell < gridSize; cell++) {
        const row = Math.floor(cell / cols);
        const col = cell % cols;
        const x = col * tileW;
        const y = row * tileH;
        layoutCoordinates.push(`${x}_${y}`);
    }
    const layoutStr = layoutCoordinates.join("|");
    // 4. Combine all inputs (scaled + fillers) in order to match layout.
    const allInputLabels = [...scaledLabels, ...fillerLabels];
    const xstackInputs = allInputLabels.map((lbl) => `[${lbl}]`).join("");
    // xstack -> stacked, then format to yuv420p to produce mixedVideo
    parts.push(`${xstackInputs}xstack=inputs=${gridSize}:layout=${layoutStr}:fill=black[stacked]`);
    parts.push(`[stacked]format=yuv420p[mixedVideo]`);
    return parts;
}
function buildAudioFilterComplex(audioInputs) {
    if (audioInputs.length === 0) {
        return [`anullsrc=channel_layout=stereo:sample_rate=48000[mixedAudio]`];
    }
    const audioLabels = audioInputs.map((a) => {
        const idx = a.inputIndex;
        return `[${idx}:a]`;
    });
    return [
        `${audioLabels.join("")}amix=inputs=${audioInputs.length}:dropout_transition=2,volume=1.5[mixedAudio]`,
    ];
}
function buildFfmpegArgs(consumedItems, filterComplex, hlsSegmentTimeSecs, hlsListSize, ffmpegExtraArgs, playlistPath) {
    const ffmpegInputs = [];
    consumedItems.forEach((c) => {
        ffmpegInputs.push("-use_wallclock_as_timestamps", "1", "-protocol_whitelist", "file,udp,rtp", "-fflags", "+genpts", "-analyzeduration", "10000000", "-probesize", "5000000", "-i", c.sdpPath);
    });
    const videoCodecArgs = ["-c:v", "libx264", "-preset", "veryfast", "-g", "48", "-keyint_min", "48"];
    const audioCodecArgs = ["-c:a", "aac", "-b:a", "128k"];
    return [
        ...ffmpegInputs,
        "-filter_complex",
        filterComplex,
        "-map",
        "[mixedVideo]",
        "-map",
        "[mixedAudio]",
        ...videoCodecArgs,
        ...audioCodecArgs,
        "-f",
        "hls",
        "-hls_time",
        String(hlsSegmentTimeSecs),
        "-hls_list_size",
        String(hlsListSize),
        "-hls_flags",
        "delete_segments+omit_endlist",
        ...ffmpegExtraArgs,
        playlistPath,
    ];
}
export async function streamAllProducersMixedHls(router, producers, outputDir, options) {
    const { basePort = 6000, targetWidth = 1280, targetHeight = 720, hlsSegmentTimeSecs = 4, hlsListSize = 5, ffmpegExtraArgs = [], playlistName = "out.m3u8", } = options || {};
    await mkdir(outputDir, { recursive: true });
    const playlistPath = path.join(outputDir, playlistName);
    if (!router)
        throw new Error("Router is required");
    const createPlainFn = getCreatePlainTransportFn(router);
    if (!createPlainFn)
        throw new Error("Router does not expose createPlainTransport/createPlainRtpTransport");
    const portAllocator = new PortAllocator(basePort);
    const consumedItems = [];
    // sequentially consume; could be parallelized with Promise.allSettled if desired
    for (const producer of producers) {
        const consumed = await consumeProducer(router, producer, portAllocator, outputDir, createPlainFn);
        if (consumed) {
            consumedItems.push(consumed);
        }
    }
    if (consumedItems.length === 0)
        throw new Error("No consumable producers found");
    // assign input indices
    consumedItems.forEach((c, idx) => {
        c.inputIndex = idx;
    });
    const videoInputs = consumedItems.filter((c) => c.kind === "video");
    const audioInputs = consumedItems.filter((c) => c.kind === "audio");
    const videoFilters = buildVideoFilterComplex(videoInputs, targetWidth, targetHeight);
    const audioFilters = buildAudioFilterComplex(audioInputs);
    const filterComplexParts = [...videoFilters, ...audioFilters];
    const filterComplex = filterComplexParts.join("; ");
    const ffmpegArgs = buildFfmpegArgs(consumedItems, filterComplex, hlsSegmentTimeSecs, hlsListSize, ffmpegExtraArgs, playlistPath);
    const ffmpegProcess = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });
    ffmpegProcess.stdout.on("data", (d) => {
        console.log("[mixed-ffmpeg stdout]", d.toString());
    });
    ffmpegProcess.stderr.on("data", (d) => {
        console.log("[mixed-ffmpeg stderr]", d.toString());
    });
    ffmpegProcess.on("exit", (code, signal) => {
        console.log(`mixed ffmpeg exited code=${code} signal=${signal}`);
    });
    const stop = () => {
        try {
            ffmpegProcess.kill("SIGTERM");
        }
        catch { }
        consumedItems.forEach((c) => {
            if (c.stopKeyframes)
                c.stopKeyframes();
            try {
                c.consumer.close();
            }
            catch { }
            try {
                c.transport.close();
            }
            catch { }
        });
    };
    return { ffmpegProcess, stop, playlistPath };
}
//# sourceMappingURL=streamer.js.map