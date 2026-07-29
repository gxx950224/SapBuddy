const { execSync } = require('child_process');
const npmBin = process.env.APPDATA + '\\npm';

// 已在 PATH 中
try { execSync('where gxx-abap 2>nul', { stdio: 'pipe' }); process.exit(0); } catch (_) {}

// setx 永久加 PATH
try {
  const out = execSync('reg query "HKCU\\Environment" /v Path 2>nul', { stdio: 'pipe', encoding: 'utf8' });
  if (!out.toUpperCase().includes(npmBin.toUpperCase())) {
    execSync('setx Path "%Path%;' + npmBin + '"', { stdio: 'pipe', windowsHide: true });
  }
} catch (_) {}

console.log('\n  gxx-abap v' + require('../package.json').version + ' installed!');
console.log('  If command not found: reopen CMD or add %APPDATA%\\npm to PATH\n');
