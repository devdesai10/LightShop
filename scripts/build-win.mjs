// Builds the Windows app (Electron shell + built web app) as a zip: extract it and run LightShop.exe.
// Usage: npm run dist:win        (LS_ARCH=arm64 for Windows on Arm)
// Works on macOS, Windows and Linux: the icon and version info are written into LightShop.exe with resedit
// (pure JavaScript, no Wine). The exe isn't code-signed.

import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const arch = process.env.LS_ARCH || 'x64';
// Marketing version shown to people: "2.0" for 2.0.0, "2.0.1" for 2.0.1.
const displayVersion = pkg.version.replace(/^(\d+\.\d+)\.0$/, '$1');
const out = path.join(root, 'release');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { stdio: 'inherit', cwd, shell: process.platform === 'win32' });
const step = (msg) => console.log(`\n› ${msg}`);

step('Building the web app');
run('npm', ['run', 'build']);

step(`Packaging LightShop for Windows (${arch})`);
const [appDir] = await packager({
  dir: root,
  out,
  overwrite: true,
  name: 'LightShop',
  executableName: 'LightShop',
  platform: 'win32',
  arch,
  asar: true,
  prune: true,
  icon: path.join(root, 'build', 'icon.ico'),
  appVersion: displayVersion,
  buildVersion: pkg.version,
  appCopyright: `LightShop ${displayVersion}`,
  win32metadata: {
    CompanyName: 'LightShop',
    FileDescription: 'LightShop',
    ProductName: 'LightShop',
    InternalName: 'LightShop',
    OriginalFilename: 'LightShop.exe',
  },
  // Ship only package.json, electron/ and dist/. Web dependencies are already bundled into dist/.
  ignore: [
    /^\/(node_modules|src|public|build|release|scripts|docs|\.kiro|\.vscode)(\/|$)/,
    /^\/(index\.html|vite\.config\.ts|tsconfig\.json|tsconfig\.tsbuildinfo|\.gitignore|package-lock\.json)$/,
    /\.map$/,
  ],
});
if (!fs.existsSync(path.join(appDir, 'LightShop.exe'))) throw new Error(`LightShop.exe missing in ${appDir}`);

// The zip holds one "LightShop" folder, so "Extract All" gives a folder that can be moved anywhere.
step('Creating the zip');
const stage = path.join(out, 'win-stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(appDir, path.join(stage, 'LightShop'), { recursive: true });
const zip = path.join(out, `LightShop-${displayVersion}-win-${arch}.zip`);
fs.rmSync(zip, { force: true });
if (process.platform === 'win32') {
  run('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path 'LightShop' -DestinationPath '${zip}'`], stage);
} else {
  run('zip', ['-r', '-X', '-9', '-q', zip, 'LightShop', '-x', '*.DS_Store'], stage);
  run('unzip', ['-tq', zip]);
}
fs.rmSync(stage, { recursive: true, force: true });

const mb = (fs.statSync(zip).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${path.relative(root, zip)} (${mb} MB)\n  App folder: ${path.relative(root, appDir)}`);
