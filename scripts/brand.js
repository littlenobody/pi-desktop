#!/usr/bin/env node
'use strict';
// 为 Electron 主程序写入图标与版本信息（Windows PE 资源）。
// 用法: node scripts/brand.js <exe 路径> [图标 ico 路径]
const fs = require('fs');
const path = require('path');

const exePath = process.argv[2];
const icoPath = process.argv[3] || path.join(__dirname, '..', 'resources', 'app', 'assets', 'icon.ico');
const version = require(path.join(__dirname, '..', 'resources', 'app', 'package.json')).version || '1.0.0';

if (!exePath || !fs.existsSync(exePath)) {
  console.error('用法: node scripts/brand.js <exe 路径> [icon.ico]');
  process.exit(1);
}

let ResEdit;
try {
  ResEdit = require('resedit');
} catch {
  console.error('缺少依赖 resedit，请先执行: npm install --no-save resedit');
  process.exit(2);
}

const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = ResEdit.NtExecutableResource.from(exe);

if (fs.existsSync(icoPath)) {
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));
}

const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
if (vi) {
  const [maj = 1, min = 0, pat = 0] = version.split('.').map((n) => parseInt(n, 10) || 0);
  for (const lang of vi.getAllLanguagesForStringValues()) {
    vi.setStringValues(lang, {
      FileDescription: 'Pi Desktop',
      ProductName: 'Pi Desktop',
      CompanyName: 'Pi Desktop',
      InternalName: 'Pi Desktop',
      OriginalFilename: 'Pi Desktop.exe',
      LegalCopyright: 'MIT',
      FileVersion: version,
      ProductVersion: version,
    });
  }
  vi.setFileVersion(maj, min, pat, 0, 1033);
  vi.setProductVersion(maj, min, pat, 0, 1033);
  vi.outputToResourceEntries(res.entries);
}

res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`[brand] 已写入图标与版本信息: ${exePath} (v${version})`);
