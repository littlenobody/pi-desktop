#!/usr/bin/env node
// 由 renderer/assets/logo.svg 生成 resources/app/assets/{icon.png,icon.ico}（多尺寸 ICO）。
// 需要 Electron 来栅格化 SVG，因此用法是把它当成一个 Electron 应用运行：
//   <electron/electron.exe> scripts/make-icons.js
//   或在 WSL/Linux: ./electron scripts/make-icons.js
// 输出目录固定为 ../resources/app/assets
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const svgPath = path.join(__dirname, '..', 'resources', 'app', 'renderer', 'assets', 'logo.svg');
const outDir = path.join(__dirname, '..', 'resources', 'app', 'assets');
const sizes = [16, 24, 32, 48, 64, 128, 256];
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<html><body></body></html>');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const pngs = await win.webContents.executeJavaScript(`(async () => {
    const svg = ${JSON.stringify(svg)};
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
    await img.decode();
    const out = {};
    for (const s of ${JSON.stringify([...sizes, 512])}) {
      const c = document.createElement('canvas'); c.width = s; c.height = s;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, s, s);
      out[s] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  })()`);
  const bufs = sizes.map((s) => Buffer.from(pngs[s], 'base64'));
  fs.writeFileSync(path.join(outDir, 'icon.png'), Buffer.from(pngs[512], 'base64'));
  // ICO
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const b = bufs[i];
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16);
    dir.writeUInt8(s >= 256 ? 0 : s, i * 16 + 1);
    dir.writeUInt8(0, i * 16 + 2); dir.writeUInt8(0, i * 16 + 3);
    dir.writeUInt16LE(1, i * 16 + 4); dir.writeUInt16LE(32, i * 16 + 6);
    dir.writeUInt32LE(b.length, i * 16 + 8); dir.writeUInt32LE(offset, i * 16 + 12);
    offset += b.length;
  });
  fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, dir, ...bufs]));
  console.log('icons written', outDir);
  app.quit();
});
