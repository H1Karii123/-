#!/usr/bin/env node
/**
 * DSH 插件安装脚本（Windows / Node 18+）
 *
 *   node install.mjs                 # 装进默认 profile（web）
 *   node install.mjs --profile web   # 指定 profile
 *   node install.mjs --dry           # 只看会做什么，不写文件
 *   node install.mjs --uninstall     # 撤销（删依赖、删 junction）
 *
 * 做三件事：
 *   1. 在 ~/.dsh/profiles/<profile>/package.json 里加一条 link: 依赖
 *   2. 把包名追加进 dsh.profile.bundles
 *   3. 在 node_modules 里建一个 junction 指回本目录
 *
 * 刻意不跑 pnpm / npm install —— 那会重新解析依赖，可能把别的 link: 插件清掉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const PKG = manifest.name;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const profile = getArg('--profile', 'web');
const dry = args.includes('--dry');
const uninstall = args.includes('--uninstall');

const log = (...a) => console.log(...a);
const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

const profileDir = path.join(os.homedir(), '.dsh', 'profiles', profile);
const pkgPath = path.join(profileDir, 'package.json');
const modulesDir = path.join(profileDir, 'node_modules');
const linkPath = path.join(modulesDir, PKG);

if (!fs.existsSync(pkgPath)) {
  die(`找不到 ${pkgPath}\n  先确认 DSH 装过，profile 名对不对（默认 web，也可能是 local / desktop）。`);
}

log(`插件     : ${PKG}`);
log(`目录     : ${HERE}`);
log(`profile  : ${profileDir}`);
if (dry) log('模式     : dry（不写文件）');

const raw = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(raw);
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : (pkg.dsh.profile.bundles = []);

const linkTarget = `link:${HERE.replace(/\\/g, '/')}`;
const changed = [];
if (uninstall) {
  if (pkg.dependencies[PKG] !== undefined) {
    delete pkg.dependencies[PKG];
    changed.push('dependencies');
  }
  const i = bundles.indexOf(PKG);
  if (i >= 0) {
    bundles.splice(i, 1);
    changed.push('bundles');
  }
} else {
  if (pkg.dependencies[PKG] !== linkTarget) {
    pkg.dependencies[PKG] = linkTarget;
    changed.push('dependencies');
  }
  if (!bundles.includes(PKG)) {
    bundles.push(PKG);
    changed.push('bundles');
  }
}

if (!changed.length) {
  log('• package.json 无需改动');
} else if (dry) {
  log(`• 会改 package.json：${changed.join(' + ')}`);
} else {
  fs.writeFileSync(`${pkgPath}.bak-${Date.now()}`, raw, 'utf8');
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`• package.json 已更新：${changed.join(' + ')}`);
}

let linked = false;
try {
  const st = fs.lstatSync(linkPath);
  linked = st.isSymbolicLink() || st.isDirectory();
} catch {
  linked = false;
}

if (uninstall) {
  if (linked) {
    if (dry) {
      log(`• 会删 junction: node_modules\\${PKG}`);
    } else {
      try {
        execFileSync('cmd', ['/c', 'rmdir', linkPath], { stdio: 'pipe' });
        log('• junction 已删');
      } catch {
        log('• junction 删不掉，手动执行：cmd /c rmdir "' + linkPath + '"');
      }
    }
  }
  log(`\n✓ 已撤销 ${PKG}。重启 DSH 生效。\n`);
  process.exit(0);
}

if (linked) {
  log(`• node_modules\\${PKG} 已存在，跳过`);
} else if (dry) {
  log(`• 会建 junction: node_modules\\${PKG} -> ${HERE}`);
} else {
  fs.mkdirSync(modulesDir, { recursive: true });
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, HERE], { stdio: 'pipe' });
    log('• junction 已建');
  } catch (err) {
    die(
      `建 junction 失败：${String(err.stderr || err.message).trim()}\n  手动：cmd /c mklink /J "${linkPath}" "${HERE}"`,
    );
  }
}

const notes = [];
if (/lore-db/.test(PKG)) {
  const home = process.env.LORE_HOME || path.join(os.homedir(), 'arknights-db');
  const db = process.env.LORE_DB || path.join(home, 'arknights.db');
  if (fs.existsSync(db)) notes.push(`知识库：${db}`);
  else notes.push(`没找到知识库 ${db}\n    先按 README 建库，或设 LORE_HOME 指向你的数据目录`);
}
if (/napcat/.test(PKG)) {
  notes.push('需要本机跑着 NapCat（OneBot HTTP，默认 http://127.0.0.1:3000）；改地址用 config.napcatBaseUrl 或环境变量 NAPCAT_HTTP');
}
if (/saibo/.test(PKG)) {
  notes.push('装完重启 DSH，设置里会多一栏「赛博鸡蛋」；独立页面 http://127.0.0.1:3080/dsh-saibo/');
}

log(`
✓ ${PKG} 已接线。最后一步：重启 DSH。
${notes.map((n) => `  · ${n}`).join('\n')}
  撤销：node install.mjs --uninstall
`);
