/**
 * make-icons.js
 * Generates PNG icon files for the extension.
 * Run: node make-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');

// ============ PNG Encoder ============

function createPNG(width, height, pixels) {
  // pixels: array of RGBA values, row by row
  // Each pixel is [R, G, B, A] (0-255)

  // PNG Signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 6;  // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = createChunk('IHDR', ihdrData);

  // IDAT: raw pixel data with filter bytes
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const offset = y * (1 + width * 4) + 1 + x * 4;
      rawData[offset] = pixels[idx];       // R
      rawData[offset + 1] = pixels[idx + 1]; // G
      rawData[offset + 2] = pixels[idx + 2]; // B
      rawData[offset + 3] = pixels[idx + 3]; // A
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idat = createChunk('IDAT', compressed);

  // IEND
  const iend = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

// CRC32 implementation
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ============ Icon Drawing ============

function drawIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 1;

  // Background: dark circle
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= r) {
        // Inside circle: dark background
        pixels[idx] = 26;   // R
        pixels[idx + 1] = 26; // G
        pixels[idx + 2] = 46; // B
        pixels[idx + 3] = 255; // A

        // Netflix red arc
        const angle = Math.atan2(dy, dx);
        const arcR = r * 0.62;
        const arcDist = Math.abs(dist - arcR);
        const arcThick = Math.max(1, size / 10);

        if (arcDist < arcThick && angle > -1.0 && angle < Math.PI + 0.6) {
          pixels[idx] = 229;   // Netflix red
          pixels[idx + 1] = 9;
          pixels[idx + 2] = 20;
        }
      } else {
        // Outside circle: transparent
        pixels[idx] = 0;
        pixels[idx + 1] = 0;
        pixels[idx + 2] = 0;
        pixels[idx + 3] = 0;
      }
    }
  }

  // Draw "CC" text using simple pixel rendering
  drawText(pixels, size, 'CC', cx - size * 0.2, cy + size * 0.16, size * 0.42, [255, 255, 255]);

  // Draw small "2"
  drawText(pixels, size, '2', cx + size * 0.16, cy + size * 0.05, size * 0.26, [255, 255, 0]);

  return pixels;
}

function drawText(pixels, size, text, startX, startY, fontSize, color) {
  // Simple bitmap font: just color a rectangular area for each letter
  const letterW = fontSize * 0.6;
  const letterH = fontSize;
  const gap = fontSize * 0.15;

  let ox = startX;
  for (const ch of text) {
    if (ch === 'C') {
      drawLetterC(pixels, size, ox, startY - letterH / 2, letterW, letterH, color);
    } else if (ch === '2') {
      drawLetter2(pixels, size, ox, startY - letterH / 2, letterW * 0.7, letterH, color);
    }
    ox += letterW + gap;
  }
}

function drawLetterC(pixels, size, x, y, w, h, color) {
  const thick = Math.max(1, w * 0.3);
  for (let py = Math.floor(y); py < y + h; py++) {
    for (let px = Math.floor(x); px < x + w; px++) {
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      const idx = (py * size + px) * 4;
      // Top bar
      if (py < y + thick && px >= x + thick) {
        setPixel(pixels, idx, color);
      }
      // Bottom bar
      else if (py >= y + h - thick && px >= x + thick) {
        setPixel(pixels, idx, color);
      }
      // Left bar
      else if (px < x + thick && py >= y + thick && py < y + h - thick) {
        setPixel(pixels, idx, color);
      }
    }
  }
}

function drawLetter2(pixels, size, x, y, w, h, color) {
  const thick = Math.max(1, w * 0.35);
  const midY = y + h / 2;
  for (let py = Math.floor(y); py < y + h; py++) {
    for (let px = Math.floor(x); px < x + w; px++) {
      if (px < 0 || px >= size || py < 0 || py >= size) continue;
      const idx = (py * size + px) * 4;
      // Top bar
      if (py < y + thick) {
        setPixel(pixels, idx, color);
      }
      // Middle bar
      else if (py >= midY - thick / 2 && py < midY + thick / 2) {
        setPixel(pixels, idx, color);
      }
      // Bottom bar
      else if (py >= y + h - thick) {
        setPixel(pixels, idx, color);
      }
      // Right-top vertical
      else if (px >= x + w - thick && py < midY) {
        setPixel(pixels, idx, color);
      }
      // Left-bottom vertical
      else if (px < x + thick && py >= midY) {
        setPixel(pixels, idx, color);
      }
    }
  }
}

function setPixel(pixels, idx, color) {
  pixels[idx] = color[0];
  pixels[idx + 1] = color[1];
  pixels[idx + 2] = color[2];
  pixels[idx + 3] = 255;
}

// ============ Generate Icons ============

const sizes = [16, 48, 128];
const iconsDir = __dirname + '/icons';

sizes.forEach(size => {
  console.log(`Generating icon${size}.png (${size}x${size})...`);
  const pixels = drawIcon(size);
  const png = createPNG(size, size, pixels);
  fs.writeFileSync(`${iconsDir}/icon${size}.png`, png);
});

console.log('Done! Icons generated in', iconsDir);
