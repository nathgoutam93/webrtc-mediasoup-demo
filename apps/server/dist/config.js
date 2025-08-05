import os from "os";
export const config = {
    http: {
        listenIp: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
        listenPort: process.env.LISTEN_PORT || 8000,
    },
    mediasoup: {
        numWorkers: Object.keys(os.cpus()).length,
        workerSettings: {
            rtcMinPort: 40000,
            rtcMaxPort: 40200,
            dtlsCertificateFile: process.env.WORKER_CERT_FULLCHAIN,
            dtlsPrivateKeyFile: process.env.WORKER_CERT_PRIVKEY,
            logLevel: "warn",
            logTags: [
                "info",
                "ice",
                "dtls",
                "rtp",
                "srtp",
                "rtcp",
                "rtx",
                "bwe",
                "score",
                "simulcast",
                "svc",
                "sctp",
            ],
            disableLiburing: false,
        },
        routerOptions: {
            mediaCodecs: [
                {
                    kind: "audio",
                    mimeType: "audio/opus",
                    clockRate: 48000,
                    channels: 2,
                },
                {
                    kind: "video",
                    mimeType: "video/VP8",
                    clockRate: 90000,
                    parameters: {
                        "x-google-start-bitrate": 1000,
                    },
                },
                {
                    kind: "video",
                    mimeType: "video/VP9",
                    clockRate: 90000,
                    parameters: {
                        "profile-id": 2,
                        "x-google-start-bitrate": 1000,
                    },
                },
                {
                    kind: "video",
                    mimeType: "video/h264",
                    clockRate: 90000,
                    parameters: {
                        "packetization-mode": 1,
                        "profile-level-id": "4d0032",
                        "level-asymmetry-allowed": 1,
                        "x-google-start-bitrate": 1000,
                    },
                },
                {
                    kind: "video",
                    mimeType: "video/h264",
                    clockRate: 90000,
                    parameters: {
                        "packetization-mode": 1,
                        "profile-level-id": "42e01f",
                        "level-asymmetry-allowed": 1,
                        "x-google-start-bitrate": 1000,
                    },
                },
            ],
        },
        webRtcServerOptions: {
            listenInfos: [
                {
                    protocol: "udp",
                    ip: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                    portRange: {
                        min: process.env.MEDIASOUP_MIN_PORT || 40000,
                        max: process.env.MEDIASOUP_MAX_PORT || 40200,
                    },
                },
                {
                    protocol: "tcp",
                    ip: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                    portRange: {
                        min: process.env.MEDIASOUP_MIN_PORT || 40000,
                        max: process.env.MEDIASOUP_MAX_PORT || 40200,
                    },
                },
            ],
        },
        webRtcTransportOptions: {
            listenInfos: [
                {
                    protocol: "udp",
                    ip: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                    portRange: {
                        min: process.env.MEDIASOUP_MIN_PORT || 40000,
                        max: process.env.MEDIASOUP_MAX_PORT || 40200,
                    },
                },
                {
                    protocol: "tcp",
                    ip: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
                    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                    portRange: {
                        min: process.env.MEDIASOUP_MIN_PORT || 40000,
                        max: process.env.MEDIASOUP_MAX_PORT || 40200,
                    },
                },
            ],
            enableUdp: true,
            enableTcp: true,
            initialAvailableOutgoingBitrate: 1000000,
            minimumAvailableOutgoingBitrate: 600000,
            maxSctpMessageSize: 262144,
            maxIncomingBitrate: 1500000,
        },
        plainTransportOptions: {
            listenInfo: {
                protocol: "udp",
                ip: process.env.MEDIASOUP_LISTEN_IP || "0.0.0.0",
                announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP,
                portRange: {
                    min: process.env.MEDIASOUP_MIN_PORT || 40000,
                    max: process.env.MEDIASOUP_MAX_PORT || 40200,
                },
            },
            maxSctpMessageSize: 262144,
            rtcpMux: false,
            comedia: false,
        },
    },
};
//# sourceMappingURL=config.js.map