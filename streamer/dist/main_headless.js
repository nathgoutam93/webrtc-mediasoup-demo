// @ts-nocheck
import fs from "fs";
import { spawn } from "child_process";
import express from "express";
import cors from "cors";
import { launch } from "puppeteer";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
process.on("unhandledRejection", (reason) => {
    console.error("🚨 Unhandled Promise Rejection:", reason);
});
process.on("uncaughtException", (err) => {
    console.error("🚨 Uncaught Exception:", err);
});
const roomId = process.argv[2];
const PORT = parseInt(process.argv[3], 10);
if (!roomId || isNaN(PORT)) {
    console.error("Usage: node stream.js <roomId> <port>");
    process.exit(1);
}
/**
 * Figure out where the preview server is running.
 * - If inside same container → localhost
 * - If on host → host.docker.internal
 * - Can be overridden with env PREVIEW_HOST
 */
const PREVIEW_HOST = process.env.PREVIEW_HOST ||
    (process.env.RUNNING_IN_DOCKER ? "host.docker.internal" : "localhost");
const PREVIEW_PORT = process.env.PREVIEW_PORT || 8000;
const PREVIEW_URL = `http://${PREVIEW_HOST}:${PREVIEW_PORT}/preview?roomId=${roomId}`;
console.log(`🌐 Using preview URL: ${PREVIEW_URL}`);
const OUT_DIR = join(__dirname, "..", "public", "hls", roomId);
fs.mkdirSync(OUT_DIR, { recursive: true });
// Local static server for generated HLS segments
const app = express();
app.use(cors());
app.use("/live", express.static(OUT_DIR));
app.listen(PORT, () => {
    console.log(`[${roomId}] HLS at http://localhost:${PORT}/live/stream.m3u8`);
});
(async () => {
    let browser;
    let ffmpeg;
    let client;
    try {
        // 1) Launch Chrome in Docker/Xvfb-safe mode
        browser = await launch({
            headless: "new",
            dumpio: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--autoplay-policy=no-user-gesture-required',
                '--use-fake-ui-for-media-stream',
                '--allow-insecure-localhost',
                '--window-size=1280,720'
            ]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });
        console.log(`🔗 Navigating to preview URL...`);
        try {
            await page.goto(PREVIEW_URL, {
                waitUntil: "networkidle0",
                timeout: 30000, // fail fast if unreachable
            });
        }
        catch (err) {
            throw new Error(`❌ Failed to load preview page: ${err.message}`);
        }
        console.log("🔍 Preview loaded, starting playback...");
        try {
            await page.mouse.click(640, 360);
        }
        catch {
            console.warn("⚠️ Could not click playback area");
        }
        // 2) Start FFmpeg for HLS output
        console.log("🎥 Starting FFmpeg...");
        ffmpeg = spawn("ffmpeg", [
            "-f",
            "mjpeg",
            "-i",
            "pipe:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-f",
            "hls",
            "-hls_time",
            "2",
            "-hls_list_size",
            "5",
            "-hls_flags",
            "delete_segments+append_list",
            "-hls_segment_filename",
            join(OUT_DIR, "segment_%03d.ts"),
            join(OUT_DIR, "stream.m3u8"),
        ], { stdio: ["pipe", "inherit", "inherit"] });
        ffmpeg.on("exit", (code) => {
            console.error(`⚠️ FFmpeg exited with code ${code}`);
        });
        // 3) Hook into Chrome DevTools Protocol for screencast
        console.log("📡 Starting Chrome screencast...");
        client = await page.target().createCDPSession();
        try {
            await client.send("Page.startScreencast", {
                format: "jpeg",
                quality: 80,
                maxWidth: 1280,
                maxHeight: 720,
                everyNthFrame: 1,
            });
        }
        catch (err) {
            throw new Error(`❌ Failed to start screencast: ${err.message}`);
        }
        client.on("Page.screencastFrame", ({ data, sessionId }) => {
            try {
                const buf = Buffer.from(data, "base64");
                ffmpeg.stdin.write(buf);
                client.send("Page.screencastFrameAck", { sessionId });
            }
            catch (err) {
                console.error("❌ Error writing frame to FFmpeg:", err);
            }
        });
        // 4) Graceful shutdown
        const shutdown = async () => {
            console.log("🛑 Shutting down stream…");
            try {
                if (client)
                    await client.send("Page.stopScreencast");
            }
            catch { }
            if (ffmpeg) {
                try {
                    ffmpeg.stdin.end();
                    ffmpeg.kill("SIGINT");
                }
                catch { }
            }
            if (browser)
                await browser.close();
            process.exit(0);
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }
    catch (err) {
        console.error("🚨 Fatal error in stream script:", err);
        if (browser)
            await browser.close().catch(() => { });
        process.exit(1);
    }
})();
//# sourceMappingURL=main_headless.js.map