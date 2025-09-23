import { useState, useRef } from "react";
import "./App.css";

function App() {
  const [isRunning, setIsRunning] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const sampleRate = 16000; // typical sample rate for PCM16 from OpenAI realtime, confirm from your setup
  const playQueueRef = useRef<AudioBuffer[]>([]);
  const isPlayingRef = useRef(false);

  const startAgent = async () => {
    if (isRunning) return;
    setIsRunning(true);
    // Setup MediaSource and audio element
    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;
    let sourceBufferAdded = false;

    // Setup AudioContext
    audioContextRef.current = new AudioContext({ sampleRate });

    const ws = new WebSocket("ws://localhost:8000/ws");
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = async (event) => {
      let arrayBuffer: ArrayBuffer;
      let bytes: Uint8Array<ArrayBuffer>;

      if (typeof event.data === "string") {
        const msg = JSON.parse(event.data);
        if (msg.type === "audio") {
          enqueuePcmChunk(msg.data); // base64 (PCM16)
          return;
        } else {
          console.warn("Received non-binary data from websocket:", event.data);
          return;
        }
      } else {
        if (event.data instanceof ArrayBuffer) {
          arrayBuffer = event.data;
          bytes = new Uint8Array(arrayBuffer);
        } else if (event.data instanceof Blob) {
          arrayBuffer = await event.data.arrayBuffer();
          bytes = new Uint8Array(arrayBuffer);
        } else {
          console.warn("Received non-binary data from websocket:", event.data);
          return;
        }
      }

      // Append to MediaSource for streaming playback
      const sb = sourceBufferRef.current;
      if (sb && !sb.updating) {
        try {
          sb.appendBuffer(bytes);
        } catch (e) {
          console.error("Error appending buffer to SourceBuffer", e);
        }
      }
    };

    mediaSource.addEventListener("sourceopen", () => {
      if (!sourceBufferAdded) {
        const sb = mediaSource.addSourceBuffer("audio/webm; codecs=opus");
        sourceBufferRef.current = sb;
        sourceBufferAdded = true;
      }
    });
    if (audioRef.current) {
      audioRef.current.src = URL.createObjectURL(mediaSource);
      audioRef.current.play();
    }

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new window.MediaRecorder(stream, {
      mimeType: "audio/webm",
    });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = async (e) => {
      if (e.data.size > 0 && wsRef.current?.readyState === 1) {
        wsRef.current.send(e.data);
      }
    };
    mediaRecorder.start(200); // send every 200ms
  };

  // Stop the agent: close websocket, stop recording
  const stopAgent = () => {
    setIsRunning(false);
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
    mediaSourceRef.current = null;
    sourceBufferRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current!.close();
      audioContextRef.current = null;
    }
    playQueueRef.current = [];
    isPlayingRef.current = false;
  };

  function base64ToFloat32(base64: string): Float32Array {
    const binary = atob(base64);
    const len = binary.length / 2; // 16-bit samples
    const buffer = new ArrayBuffer(len * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < len; i++) {
      const lo = binary.charCodeAt(i * 2);
      const hi = binary.charCodeAt(i * 2 + 1);
      const value = (hi << 8) | lo;
      view.setInt16(i * 2, value, true);
    }

    const pcm16 = new Int16Array(buffer);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768; // normalize
    }
    return float32;
  }

  // Queue PCM16 chunk for playback
  function enqueuePcmChunk(base64: string) {
    const ctx = audioContextRef.current!;
    const samples = base64ToFloat32(base64);

    const audioBuffer = ctx.createBuffer(1, samples.length, 16000); // 16kHz mono
    audioBuffer.getChannelData(0).set(samples);

    playQueueRef.current.push(audioBuffer);

    if (!isPlayingRef.current) {
      playNext();
    }
  }
  // Play next queued buffer
  function playNext() {
    if (playQueueRef.current.length === 0) {
      isPlayingRef.current = false;
      return;
    }
    isPlayingRef.current = true;

    const ctx = audioContextRef.current!;
    const buffer = playQueueRef.current.shift()!;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    source.onended = () => {
      playNext();
    };

    source.start();
  }

  return (
    <div className="voice-agent-container">
      <h1>Voice Agent</h1>
      <div style={{ marginBottom: 16 }}>
        <button
          onClick={startAgent}
          disabled={isRunning}
          style={{ marginRight: 8 }}
        >
          Start
        </button>
        <button onClick={stopAgent} disabled={!isRunning}>
          Stop
        </button>
      </div>
      <p>Status: {isRunning ? "Running" : "Stopped"}</p>
      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
}

export default App;