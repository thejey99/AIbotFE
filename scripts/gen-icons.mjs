import sharp from "sharp";
import { readFileSync, mkdirSync } from "node:fs";

const svg = readFileSync("public/apple-icon-source.svg");
mkdirSync("public", { recursive: true });

await sharp(svg, { density: 300 })
  .resize(180, 180)
  .png()
  .toFile("public/apple-touch-icon.png");

console.log("Generated public/apple-touch-icon.png (180x180)");
