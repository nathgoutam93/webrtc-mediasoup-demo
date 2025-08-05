import dgram from "dgram";

export class RtpSwitcher {
    constructor(realPort, fillerPort, outPort, host = "127.0.0.1", fallbackTimeoutMs = 0) {
        this.host = host;
        this.outPort = outPort;
        this.fallbackTimeoutMs = fallbackTimeoutMs;

        // RTP state
        this.outSeq = Math.floor(Math.random() * 50000);
        this.outTimestamp = 0;
        this.baseTimestampSet = false;
        this.ssrc = Math.floor(Math.random() * 0xffffffff);
        this.lastRealPacketTime = 0;

        // sockets
        this.out = dgram.createSocket("udp4");
        this.socketReal = dgram.createSocket("udp4");
        this.socketFiller = dgram.createSocket("udp4");

        this.socketFiller.on("message", (msg) => {
            const now = Date.now();
            // Send filler immediately if real is dead, no waiting
            if (now - this.lastRealPacketTime > this.fallbackTimeoutMs) {
                this.forwardPacket(msg);
            }
        });

        this.socketReal.on("message", (msg) => {
            this.lastRealPacketTime = Date.now();
            this.forwardPacket(msg);
        });


        // Bind sockets
        this.socketReal.bind(realPort);
        this.socketFiller.bind(fillerPort);

        console.log(`RtpSwitcher: real=${realPort}, filler=${fillerPort} → out=${outPort}`);
    }

    /**
     * Parse and normalize RTP packet
     */
    forwardPacket(msg) {
        if (msg.length < 12) return; // invalid RTP

        const buf = Buffer.from(msg);

        // Read incoming sequence, timestamp
        const inSeq = buf.readUInt16BE(2);
        const inTimestamp = buf.readUInt32BE(4);

        // First packet: set base timestamp
        if (!this.baseTimestampSet) {
            this.baseTimestamp = inTimestamp;
            this.baseTimestampSet = true;
            this.outTimestamp = 0;
        }

        // Calculate new timestamp relative to base
        const tsDiff = (inTimestamp - this.baseTimestamp) >>> 0; // unsigned wrap-safe
        this.outTimestamp = (this.outTimestamp + Math.max(1, tsDiff - this.outTimestamp)) >>> 0;

        // Write new sequence number
        buf.writeUInt16BE(this.outSeq & 0xffff, 2);
        this.outSeq++;

        // Write adjusted timestamp
        buf.writeUInt32BE(this.outTimestamp >>> 0, 4);

        // Force constant SSRC
        buf.writeUInt32BE(this.ssrc >>> 0, 8);

        // Send to output
        this.out.send(buf, this.outPort, this.host);
    }

    close() {
        this.socketReal.close();
        this.socketFiller.close();
        this.out.close();
    }
}
