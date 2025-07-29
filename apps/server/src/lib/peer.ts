import { EventEmitter } from "events";
import WebSocket from "ws";

class Peer extends EventEmitter {
  id: string;
  ws: WebSocket;
  data: Record<string, any>;

  private _nextReqId: number;
  private _pendingRequests: Map<
    number,
    { resolve: Function; reject: Function }
  >;

  public onRequest?: (data: any) => void;
  public onNotification?: (data: any) => void;

  constructor(id: string, ws: WebSocket) {
    super();

    this.id = id;
    this.ws = ws;
    this.data = {};

    this._nextReqId = 1;
    this._pendingRequests = new Map();

    this._handleWebSocket();
  }

  private _handleWebSocket() {
    this.ws.on("message", (msg: WebSocket.RawData) => {
      try {
        const data = JSON.parse(msg.toString());

        if (data.response && this._pendingRequests.has(data.id)) {
          const { resolve, reject } = this._pendingRequests.get(data.id)!;
          this._pendingRequests.delete(data.id);

          data.ok ? resolve(data.data) : reject(data.errorReason);
        } else if (data.request) {
          this.onRequest?.(data);
          this.emit("request", data);
        } else if (data.notification) {
          this.onNotification?.(data);
          this.emit("notification", data);
        }
      } catch (err) {
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

  notify(method: string, data: unknown): void {
    this._send({
      notification: true,
      method,
      data,
    });
  }

  request(method: string, data: unknown): Promise<any> {
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

  respond(id: number, ok: boolean, dataOrError: any): void {
    const res = {
      response: true,
      id,
      ok,
      ...(ok ? { data: dataOrError } : { errorReason: dataOrError }),
    };

    // console.log("response::", res);

    this._send(res);
  }

  private _send(msg: any): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn(`Cannot send to peer ${this.id}, WebSocket is not open`);
    }
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.emit("close");
  }
}

export default Peer;
