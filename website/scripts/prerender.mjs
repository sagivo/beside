// Build-time SSR: render the React app to static HTML and inject it
// into the client index.html so the page is fully crawlable / OCR-friendly
// for search engines and indexers, while still hydrating on the client.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const clientDir = path.join(root, "dist/client");
const serverDir = path.join(root, "dist/server");

const template = fs.readFileSync(path.join(clientDir, "index.html"), "utf-8");
const { render } = await import(pathToFileURL(path.join(serverDir, "entry-server.js")).href);

const appHtml = render();
const html = template.replace("<!--app-html-->", appHtml);

fs.writeFileSync(path.join(clientDir, "index.html"), html);

console.log("✓ Prerendered index.html with SSR markup");
