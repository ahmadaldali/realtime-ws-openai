
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "child_process";

// Spawn ffmpeg to convert PCM16 16kHz raw audio to webm opus
const ffmpeg = spawn("ffmpeg", [
  "-f",
  "s16le", // input format: signed 16-bit little endian PCM
  "-ar",
  "16000", // input sample rate
  "-ac",
  "1", // input channels (mono)
  "-i",
  "pipe:0", // read input from stdin
  "-c:a",
  "libopus", // encode audio in Opus codec
  "-b:a",
  "64k", // audio bitrate
  "-f",
  "webm", // output format container
  "pipe:1", // output to stdout
]);

ffmpeg.stderr.on("data", (data) => {
  console.error("ffmpeg stderr:", data.toString());
});

ffmpeg.on("close", (code) => {
  // console.log(`ffmpeg process exited with code ${code}`);
});

const LOCAL_PORT = 8000;
const OPENAI_WS_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const OPENAI_API_KEY =
  "";

function isBase64(str) {
  // Regex to check Base64 format including padding
  const regexBase64 =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})$/;
  if (!regexBase64.test(str)) {
    return false;
  }
  try {
    // Try decoding the Base64 string
    atob(str);
    return true;
  } catch (e) {
    return false;
  }
}

function toBase64(u8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < u8Array.length; i += chunkSize) {
    const chunk = u8Array.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

// Create your WebSocket server for clients
const server = new WebSocketServer({ port: LOCAL_PORT });

server.on("connection", (clientSocket) => {
  console.log("Client connected");

  clientSocket.on("message", async (message) => {
    // console.log(`Received from client: ${message}`);

    const base64Message = toBase64(message);
    // console.log("isBase64", isBase64(base64Message));

    // Optionally: forward client message to OpenAI
    // You may want to format message as JSON etc depending on OpenAI's API demands
    openaiSocket.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: base64Message,
      })
    );

    // Also echo or respond immediately to client
    //clientSocket.send(message);

    // openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    openaiSocket.send(JSON.stringify({ type: "response.create" }));
  });

  clientSocket.on("close", () => {
    console.log("Client disconnected");
  });
});

console.log(`WebSocket server is running on ws://localhost:${LOCAL_PORT}`);

// ----------- Part: connection to OpenAI’s WebSocket API -----------

const openaiSocket = new WebSocket(OPENAI_WS_URL, {
  headers: {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    "OpenAI-Beta": "realtime=v1",
  },
});

openaiSocket.on("open", () => {
  console.log("Connected to OpenAI realtime WS");

  // Depending on API, you might need to send an initialization message
  // e.g. send model, settings etc.

  openaiSocket.send(
    JSON.stringify({
      type: "session.update",
      session: {
        model: "gpt-4o-realtime-preview",
        output_audio_format: "pcm16",
        modalities: ["text", "audio"],
      },
    })
  );
});

openaiSocket.on("message", (msg) => {
  const data = JSON.parse(msg);
  if (data.type === "response.audio.delta") {
    const audioBase64 = data.delta;
    // console.log('Received audio chunk:', audioBase64.slice(0, 20) + '...'); // log start of base64 chunk

    const pcmChunk = Buffer.from(audioBase64, "base64");
    // Write chunk into ffmpeg stdin for conversion
    ffmpeg.stdin.write(pcmChunk);
  }
});

// Stream ffmpeg stdout (opus webm chunks) back to clients
ffmpeg.stdout.on("data", (chunk) => {
  // Broadcast encoded WebM Opus chunk as binary to all connected clients
  server.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(chunk);
    }
  });
});

openaiSocket.on("close", () => {
  console.log("OpenAI connection closed");
  if (server.clients.size === 0) {
    ffmpeg.stdin.end();
  }
});

openaiSocket.on("error", (err) => {
  console.error("OpenAI WS error:", err);
});