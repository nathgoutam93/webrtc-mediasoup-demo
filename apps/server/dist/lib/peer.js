import { EventEmitter } from "events";
import WebSocket from "ws";
class Peer extends EventEmitter {
    id;
    ws;
    data;
    _nextReqId;
    _pendingRequests;
    onRequest;
    onNotification;
    constructor(id, ws) {
        super();
        this.id = id;
        this.ws = ws;
        this.data = {};
        this._nextReqId = 1;
        this._pendingRequests = new Map();
        this._handleWebSocket();
    }
    _handleWebSocket() {
        this.ws.on("message", (msg) => {
            try {
                const data = JSON.parse(msg.toString());
                if (data.response && this._pendingRequests.has(data.id)) {
                    const { resolve, reject } = this._pendingRequests.get(data.id);
                    this._pendingRequests.delete(data.id);
                    data.ok ? resolve(data.data) : reject(data.errorReason);
                }
                else if (data.request) {
                    this.onRequest?.(data);
                    this.emit("request", data);
                }
                else if (data.notification) {
                    this.onNotification?.(data);
                    this.emit("notification", data);
                }
            }
            catch (err) {
                console.error(`Invalid message from peer ${this.id}:`, err);
            }
        });
        this.ws.on("close", () => {
            this.emit("close");
        });
        this.ws.on("error", (err) => {
            console.warn(`WebSocket error from peer ${this.id}:`, err);
        });
    }
    notify(method, data) {
        this._send({
            notification: true,
            method,
            data,
        });
    }
    request(method, data) {
        return new Promise((resolve, reject) => {
            const id = this._nextReqId++;
            this._pendingRequests.set(id, { resolve, reject });
            this._send({
                request: true,
                id,
                method,
                data,
            });
        });
    }
    respond(id, ok, dataOrError) {
        const res = {
            response: true,
            id,
            ok,
            ...(ok ? { data: dataOrError } : { errorReason: dataOrError }),
        };
        // console.log("response::", res);
        this._send(res);
    }
    _send(msg) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
        else {
            console.warn(`Cannot send to peer ${this.id}, WebSocket is not open`);
        }
    }
    close() {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
        this.emit("close");
    }
}
export default Peer;
//# sourceMappingURL=peer.js.map