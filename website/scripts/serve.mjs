// Tiny zero-dependency static server for `dist/client`.
// Useful for verifying the prerendered HTML locally.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, "../dist/client");
const port = Number(process.env.PORT) || 4173;

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    let filePath = path.join(dist, url === "/" ? "index.html" : url);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(dist, "index.html");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  })
  .listen(port, () => console.log(`→ http://localhost:${port}`));
