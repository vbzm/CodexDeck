import fs from 'node:fs';
import path from 'node:path';

const source = path.resolve('public/assets/codex-logo-dark.png');
const destination = path.resolve('desktop/assets/codexdeck.ico');
const png = fs.readFileSync(source);
if (png.readUInt32BE(16) !== 256 || png.readUInt32BE(20) !== 256) {
  throw new Error('Windows 图标源文件必须是 256×256 PNG');
}
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
png.copy(ico, 22);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, ico);
console.log('已生成 Windows 图标：' + destination);
