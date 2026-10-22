// Builds LightShop.app (Electron shell + built web app) and a drag-to-Applications DMG.
// Usage: npm run dist:mac        (LS_ARCH=x64 to build for Intel Macs)

import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const arch = process.env.LS_ARCH || (process.arch === 'x64' ? 'x64' : 'arm64');
// Marketing version shown to people: "2.0" for 2.0.0, "2.0.1" for 2.0.1.
const displayVersion = pkg.version.replace(/^(\d+\.\d+)\.0$/, '$1');
const out = path.join(root, 'release');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root });
const step = (msg) => console.log(`\n› ${msg}`);

if (process.platform !== 'darwin') {
  console.error('The DMG can only be built on macOS.');
  process.exit(1);
}

step('Building the web app');
run('npm', ['run', 'build']);

step(`Packaging LightShop.app (${arch})`);
const [bundleDir] = await packager({
  dir: root,
  out,
  overwrite: true,
  name: 'LightShop',
  executableName: 'LightShop',
  platform: 'darwin',
  arch,
  asar: true,
  prune: true,
  icon: path.join(root, 'build', 'icon.icns'),
  appBundleId: 'dev.lightshop.app',
  appCategoryType: 'public.app-category.photography',
  appVersion: displayVersion,
  buildVersion: pkg.version,
  appCopyright: `LightShop ${displayVersion}`,
  darwinDarkModeSupport: true,
  extendInfo: { LSMinimumSystemVersion: '12.0' },
  // Ship only package.json, electron/ and dist/. Web dependencies are already bundled into dist/.
  ignore: [
    /^\/(node_modules|src|public|build|release|scripts|docs|\.kiro|\.vscode)(\/|$)/,
    /^\/(index\.html|vite\.config\.ts|tsconfig\.json|tsconfig\.tsbuildinfo|\.gitignore|package-lock\.json)$/,
    /\.map$/,
  ],
});
const appPath = path.join(bundleDir, 'LightShop.app');

// No Apple Developer ID here, so sign ad hoc: required for Apple Silicon to launch the modified bundle.
step('Signing (ad hoc)');
run('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath]);

step('Creating the DMG');
const stage = path.join(out, 'dmg-stage');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
run('ditto', [appPath, path.join(stage, 'LightShop.app')]);
fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
const dmg = path.join(out, `LightShop-${displayVersion}-${arch}.dmg`);
fs.rmSync(dmg, { force: true });
// The mounted disk shows up in Finder as "LightShop 2.0".
run('hdiutil', ['create', '-volname', `LightShop ${displayVersion}`, '-srcfolder', stage, '-fs', 'HFS+', '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-ov', dmg]);
fs.rmSync(stage, { recursive: true, force: true });
run('hdiutil', ['verify', dmg]);

const mb = (fs.statSync(dmg).size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${path.relative(root, dmg)} (${mb} MB)\n  App bundle: ${path.relative(root, appPath)}`);
