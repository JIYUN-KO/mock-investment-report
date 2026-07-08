import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(root, "dist");
const shareDir = resolve(root, "share");
const outputFile = resolve(shareDir, "모의주식_투자성적표_프로그램.html");

let html = await readFile(resolve(distDir, "index.html"), "utf8");

const cssMatches = [...html.matchAll(/<link rel="stylesheet" crossorigin href="([^"]+)">/g)];
for (const [, href] of cssMatches) {
  const css = await readFile(resolve(distDir, href.replace(/^\//, "")), "utf8");
  html = html.replace(
    new RegExp(`<link rel="stylesheet" crossorigin href="${escapeRegExp(href)}">`),
    `<style>\n${css}\n</style>`
  );
}

const scriptMatches = [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"><\/script>/g)];
for (const [, src] of scriptMatches) {
  const js = await readFile(resolve(distDir, src.replace(/^\//, "")), "utf8");
  const jsDataUrl = `data:text/javascript;base64,${Buffer.from(js, "utf8").toString("base64")}`;
  html = html.replace(
    new RegExp(`<script type="module" crossorigin src="${escapeRegExp(src)}"></script>`),
    `<script type="module" src="${jsDataUrl}"></script>`
  );
}

html = html.replace(
  "</head>",
  `  <meta name="description" content="모의주식 투자 성적표 공유용 단일 HTML 프로그램" />\n</head>`
);

await mkdir(shareDir, { recursive: true });
await writeFile(outputFile, html, "utf8");

console.log(outputFile);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
