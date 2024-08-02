const WebSocket = require('ws');
const EventEmitter = require('events');

module.exports = class WebSocketService {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0);
    this.subscribedRooms = new Set();
    this.connect();
  }

  connect() {
    this.socket = new WebSocket(this.wsUrl);

    this.socket.on("open", () => {
      this.resubscribeToRooms();
    });

    this.socket.on("message", (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === "message") {
          this.emitter.emit(message.room, message.data);
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    this.socket.on("close", () => {
      console.info("Disconnected from WebSocket server");
      setTimeout(() => this.connect(), 5000);
    });
  }

  joinRoom(room) {
    this.subscribedRooms.add(room);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "join", room }));
    }
  }

  leaveRoom(room) {
    this.subscribedRooms.delete(room);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "leave", room }));
    }
  }

  on(room, listener) {
    this.emitter.on(room, listener);
  }

  resubscribeToRooms() {
    if (this.socket.readyState === WebSocket.OPEN) {
      for (const room of this.subscribedRooms) {
        this.socket.send(JSON.stringify({ type: "join", room }));
      }
    }
  }
}
