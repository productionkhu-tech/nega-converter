// Generates icon.png (512) and icon.ico (multi-size) from icon.svg
// Run: npm run icons
const sharp = require('sharp');
const _pti = require('png-to-ico');
const pngToIco = typeof _pti === 'function' ? _pti : _pti.default;
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, 'icon.svg');
const outPng = path.join(__dirname, 'icon.png');
const outIco = path.join(__dirname, 'icon.ico');

(async () => {
  const svg = fs.readFileSync(svgPath);

  // 512x512 PNG (electron-builder uses this as the canonical icon)
  await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(outPng);

  // Multi-resolution ICO for Windows (taskbar, explorer, shortcuts)
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const buffers = [];
  for (const s of sizes) {
    buffers.push(await sharp(svg, { density: 384 }).resize(s, s).png().toBuffer());
  }
  fs.writeFileSync(outIco, await pngToIco(buffers));

  console.log('Generated:', outPng);
  console.log('Generated:', outIco);
})().catch((e) => { console.error(e); process.exit(1); });
