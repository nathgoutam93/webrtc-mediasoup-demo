//@ts-nocheck
import { launch, executablePath } from "puppeteer";
import { spawn } from "child_process";
import express from "express";
import cors from 'cors';
import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// CLI args
const roomId = process.argv[2];
const PORT = parseInt(process.argv[3], 10);
if (!roomId || isNaN(PORT)) {
    console.error("Usage: node stream.js <roomId> <port>");
    process.exit(1);
}
const PREVIEW_HOST = process.env.PREVIEW_HOST || "localhost";
const PREVIEW_PORT = process.env.PREVIEW_PORT || 8000;
const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}/preview?roomId=${roomId}`;
const OUT_DIR = join(__dirname, "..", "public", "hls", roomId);
fs.mkdirSync(OUT_DIR, { recursive: true });
// Serve HLS
const app = express();
app.use(cors());
app.use("/live", express.static(OUT_DIR));
app.listen(PORT, () => console.log(`[${roomId}] HLS available at http://localhost:${PORT}/live/stream.m3u8`));
(async () => {
    const browser = await launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--window-size=1280,720',
            "--use-fake-ui-for-media-stream"
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || executablePath()
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(PREVIEW_URL, { waitUntil: "networkidle0", timeout: 60000 });
    console.log("[Puppeteer] Preview loaded");
    // FFmpeg: input from two pipes
    const ffmpeg = spawn("ffmpeg", [
        "-y",
        // Video input from pipe 3
        "-f", "image2pipe",
        "-framerate", "25",
        "-i", "pipe:3",
        // Audio input from pipe 4
        "-f", "webm",
        "-i", "pipe:4",
        // Encoding
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "128k",
        // HLS settings
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_flags", "delete_segments+append_list",
        "-hls_segment_filename", join(OUT_DIR, "segment_%03d.ts"),
        join(OUT_DIR, "stream.m3u8")
    ], { stdio: ["pipe", "inherit", "inherit", "pipe", "pipe"] });
    // === VIDEO CAPTURE (CDP Screencast API) ===
    const client = await page.target().createCDPSession();
    await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: 80,
        everyNthFrame: 1
    });
    client.on("Page.screencastFrame", async (frame) => {
        const buffer = Buffer.from(frame.data, "base64");
        if (!ffmpeg.stdio[3].write(buffer)) {
            await new Promise((resolve) => ffmpeg.stdio[3].once("drain", resolve));
        }
        await client.send("Page.screencastFrameAck", { sessionId: frame.sessionId });
    });
    // === AUDIO CAPTURE (MediaRecorder in Page) ===
    await page.exposeFunction("sendAudioChunk", (base64Data) => {
        const buf = Buffer.from(base64Data, "base64");
        ffmpeg.stdio[4].write(buf);
    });
    await page.evaluate(() => {
        async function startAudioCapture() {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const recorder = new MediaRecorder(stream, {
                mimeType: "audio/webm",
                audioBitsPerSecond: 128000
            });
            recorder.ondataavailable = async (e) => {
                if (e.data.size > 0) {
                    const buf = await e.data.arrayBuffer();
                    const base64 = btoa(new Uint8Array(buf).reduce((acc, byte) => acc + String.fromCharCode(byte), ""));
                    await window.sendAudioChunk(base64);
                }
            };
            recorder.start(250); // send audio every 250ms
        }
        startAudioCapture();
    });
    // use loop back for tab audio
    // await page.evaluate(async () => {
    //   const devices = await navigator.mediaDevices.enumerateDevices();
    //   const loopback = devices.find(d => d.kind === "audioinput" && d.label.includes("BlackHole"));
    //   if (!loopback) {
    //     console.error("No BlackHole input found");
    //     return;
    //   }
    //   const stream = await navigator.mediaDevices.getUserMedia({
    //     audio: { deviceId: loopback.deviceId }
    //   });
    //   const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    //   recorder.ondataavailable = async (e) => {
    //     if (e.data.size > 0) {
    //       const buf = await e.data.arrayBuffer();
    //       const base64 = btoa(
    //         new Uint8Array(buf).reduce((acc, byte) => acc + String.fromCharCode(byte), "")
    //       );
    //       await window.sendAudioChunk(base64);
    //     }
    //   };
    //   recorder.start(250);
    // });
    // Monitor output
    setInterval(() => {
        fs.readdir(OUT_DIR, (err, files) => {
            if (!err)
                console.log(`[Monitor] HLS folder: ${files.join(", ")}`);
        });
    }, 5000);
    // Graceful shutdown
    const shutdown = async () => {
        console.log("Shutting down…");
        try {
            ffmpeg.stdio[3].end();
            ffmpeg.stdio[4].end();
            ffmpeg.kill("SIGINT");
            await browser.close();
            process.exit(0);
        }
        catch (e) {
            console.error("Shutdown error:", e);
            process.exit(1);
        }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
})();
//# sourceMappingURL=main.js.map