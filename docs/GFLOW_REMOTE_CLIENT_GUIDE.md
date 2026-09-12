# 🎬 Google Flow API Proxy — Remote Client & LLM Integration Guide

**Target Audience:** Autonomous Agents, Remote LLMs (Paseo, Hermes, Cursor), Secondary PCs/MacBooks, and Developers.  
**Server Host:** ThinkPad X1 (`100.74.82.76` on Tailscale Mesh).  
**Proxy Port:** `1235`.

---

## 1. How the gflow Proxy Works (Under the Hood)

The `gflow-api-proxy` turns local browser automation (`gflow` CLI driving Chrome via Playwright) into a standardized, remote-accessible REST API for **Google Veo 3.1** (video generation) and **Imagen / Nano Banana** (image generation).

```
[ Remote PC / LLM Client ]
           │
           │ HTTP POST (over Tailscale: 100.74.82.76:1235)
           ▼
┌───────────────────────────────────────────────────────────┐
│                    gflow-api-proxy                        │
│                                                           │
│  1. Auth & Validation  ──▶ Checks Bearer GFLOW_API_KEY    │
│  2. Queue Serialization──▶ FIFO Queue per Google Profile  │
│                            (Prevents Chrome SingletonLock)│
│  3. Playwright Runner  ──▶ Headless Chrome (`DISPLAY=:0`) │
│  4. Local Media Server ──▶ Stores output in `storage/`    │
│  5. Remote Links       ──▶ Formats direct Tailscale URLs  │
│  6. R2 Uploader (Opt)  ──▶ Syncs to Cloudflare R2 bucket  │
└───────────────────────────────────────────────────────────┘
           │
           ▼
[ Output: MP4 Video / JPG / PNG with HTTP Range streaming & Base64 preview ]
```

### Key Architectural Strengths:
1. **Anti-Lock Profile Serialization (`QueueManager`)**:
   - Google Chrome profiles (`profile_giovannidegattis`) cannot be opened by multiple Playwright instances simultaneously without crashing with `SingletonLock` or `ProfileLockedError`.
   - The proxy maintains a dedicated FIFO queue for each Google profile, automatically clears dead lockfiles, and serializes execution cleanly.
2. **Local Media Hosting with Zero Buffering**:
   - All generated media is saved in `/storage/` on the server and immediately served via `/media/<filename>` with native HTTP `Range` header support (essential for instant video scrubbing in browsers and chat clients).
3. **Tailscale Native**:
   - The proxy auto-detects its Tailscale IP (`100.74.82.76`) and generates direct markdown embeds (`![Preview](http://100.74.82.76:1235/media/...)`) for remote viewing.
4. **Cloudflare R2 on Demand**:
   - Setting `"upload_r2": true` automatically pushes the file to Cloudflare R2 and provides an additional public CDN link.

---

## 2. Remote Connection Details

| Property | Value |
| :--- | :--- |
| **Base URL (Remote via Tailscale)** | `http://100.74.82.76:1235` |
| **Base URL (Local on Host)** | `http://127.0.0.1:1235` |
| **Authentication Header** | `Authorization: Bearer <YOUR_GFLOW_API_KEY>` |
| **API Key Header (Alternative)** | `X-Api-Key: <YOUR_GFLOW_API_KEY>` |

---

## 3. Core API Endpoints

### 3.1 Health & Status Check
```bash
curl -s http://100.74.82.76:1235/health | jq .
```
Returns service state, active tasks, queued tasks, and profile status.

---

### 3.2 Generate Video (Text-to-Video / Veo 3.1)
* **Endpoint:** `POST /v1/video/t2v`
* **Models:** `omni-flash` (default fast Veo), `veo-2`
* **Aspect Ratios:** `16:9` (landscape), `9:16` (portrait / reels), `1:1` (square)

```bash
curl -X POST http://100.74.82.76:1235/v1/video/t2v \
  -H "Authorization: Bearer <YOUR_GFLOW_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Cinematic macro shot of dew drops on an autumn leaf, soft morning light",
    "model": "omni-flash",
    "aspect": "16:9",
    "wait": true
  }'
```

**Response (200 OK):**
```json
{
  "task_id": "task_1726157120_abc123",
  "status": "completed",
  "media_type": "video",
  "filename": "video_1726157120.mp4",
  "local_path": "/home/ggg/vibes/gflow-api-proxy/storage/video_1726157120.mp4",
  "url": "http://100.74.82.76:1235/media/video_1726157120.mp4",
  "markdown_preview": "![Video](http://100.74.82.76:1235/media/video_1726157120.mp4)"
}
```

---

### 3.3 Animate Image to Video (Image-to-Video / Veo 3.1)
* **Endpoint:** `POST /v1/video/i2v`
* Animate from an initial frame on the host or a remote URL:

```bash
curl -X POST http://100.74.82.76:1235/v1/video/i2v \
  -H "Authorization: Bearer <YOUR_GFLOW_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "The camera slowly pans out while the character smiles gently",
    "initial_frame": "/home/ggg/vibes/gflow-api-proxy/storage/character_keyframe.jpg",
    "aspect": "9:16",
    "wait": true
  }'
```

---

### 3.4 Generate Image (Imagen 3 / Nano Banana)
* **Endpoint:** `POST /v1/image/t2i`
* **Models:** `nano-pro` (default), `nano2`, `image4`
* **Aspect Ratios:** `1:1`, `16:9`, `9:16`, `4:3`, `3:4`

```bash
curl -X POST http://100.74.82.76:1235/v1/image/t2i \
  -H "Authorization: Bearer <YOUR_GFLOW_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Cyberpunk programmer working on a laptop in a rainy neon-lit alley",
    "model": "nano-pro",
    "aspect": "1:1",
    "wait": true
  }'
```

---

### 3.5 OpenAI Drop-In Endpoint (`/v1/images/generations`)
Compatible with standard OpenAI client libraries (`openai.images.generate`):

```bash
curl -X POST http://100.74.82.76:1235/v1/images/generations \
  -H "Authorization: Bearer <YOUR_GFLOW_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Futuristic clean minimalist architecture at twilight",
    "size": "1024x1024"
  }'
```

**OpenAI-Compatible Response:**
```json
{
  "created": 1789229000,
  "data": [
    {
      "url": "http://100.74.82.76:1235/media/img_1789229000.png"
    }
  ]
}
```

---

### 3.6 Asynchronous Background Execution (`wait: false`)
When generating multiple videos or handling long jobs without blocking the HTTP connection:
1. Pass `"wait": false` in the request body.
2. The proxy responds immediately with `202 Accepted` and a `task_id`.
3. Poll task status:
   ```bash
   curl -s -H "Authorization: Bearer <YOUR_GFLOW_API_KEY>" \
     http://100.74.82.76:1235/v1/tasks/<task_id>
   ```

---

## 4. Code Examples for the Other Computer

### Python Client (`client.py`)
```python
import os
import requests

GFLOW_URL = os.getenv("GFLOW_BASE_URL", "http://100.74.82.76:1235")
GFLOW_KEY = os.getenv("GFLOW_API_KEY", "<YOUR_GFLOW_API_KEY>")

headers = {
    "Authorization": f"Bearer {GFLOW_KEY}",
    "Content-Type": "application/json"
}

def generate_video(prompt: str, aspect: str = "16:9") -> str:
    res = requests.post(f"{GFLOW_URL}/v1/video/t2v", headers=headers, json={
        "prompt": prompt,
        "model": "omni-flash",
        "aspect": aspect,
        "wait": True
    })
    res.raise_for_status()
    data = res.json()
    print(f"Video URL: {data['url']}")
    return data["url"]

def generate_image(prompt: str, aspect: str = "1:1") -> str:
    res = requests.post(f"{GFLOW_URL}/v1/image/t2i", headers=headers, json={
        "prompt": prompt,
        "model": "nano-pro",
        "aspect": aspect,
        "wait": True
    })
    res.raise_for_status()
    data = res.json()
    print(f"Image URL: {data['url']}")
    return data["url"]

if __name__ == "__main__":
    generate_image("A futuristic sleek electric sports car in studio lighting")
```

### TypeScript / Node.js
```typescript
const GFLOW_URL = "http://100.74.82.76:1235";
const GFLOW_KEY = "<YOUR_GFLOW_API_KEY>";

async function createVideo(prompt: string) {
  const response = await fetch(`${GFLOW_URL}/v1/video/t2v`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GFLOW_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      model: "omni-flash",
      aspect: "16:9",
      wait: true,
    }),
  });

  const result = await response.json();
  console.log("Generated media URL:", result.url);
  return result;
}
```

---

## 5. Summary of Ports on the ThinkPad Server

| Service | Port | Tailscale URL | Purpose |
| :--- | :--- | :--- | :--- |
| **ACP OpenAI Proxy** | `1234` | `http://100.74.82.76:1234/v1` | LLM inference (Claude 4.6, Gemini 3.8 Flash, GPT OSS 120B) |
| **Google Flow Proxy** | `1235` | `http://100.74.82.76:1235` | Video (Veo 3.1) & Image (Imagen/Nano) generation |
