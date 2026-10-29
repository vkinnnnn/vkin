// @ts-check
'use strict';
// Local OCR for screen context (PRD Phase 5): Windows.Media.Ocr through Windows PowerShell's WinRT
// bridge. Runs offline on this machine; nothing is uploaded. The image is written to a private temp
// file only for the OCR call and deleted immediately afterwards.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn: nodeSpawn } = require('node:child_process');

const TIMEOUT_MS = 20000;

// Reads the image path from an environment variable, so no user data is ever interpolated into the script.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(); $t.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:FABEL_OCR_IMAGE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { throw 'no OCR language is installed for this Windows user' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$stream.Dispose()
[Console]::OutputEncoding = [Text.Encoding]::UTF8
foreach ($line in $result.Lines) { [Console]::Out.WriteLine($line.Text) }
`;

/**
 * @param {Buffer} png image bytes (PNG or JPEG)
 * @param {{ spawn?: typeof nodeSpawn, platform?: string, tmpDir?: string, timeoutMs?: number }} [deps]
 * @returns {Promise<{ text: string, lines: number, ms: number }>}
 */
async function ocrImage(png, deps = {}) {
  if ((deps.platform || process.platform) !== 'win32') throw new Error('local OCR is available on Windows only');
  if (!Buffer.isBuffer(png) || png.length < 8) throw new Error('no image to read');
  const spawn = deps.spawn || nodeSpawn;
  const file = path.join(deps.tmpDir || os.tmpdir(), `fabel-ocr-${crypto.randomBytes(8).toString('hex')}.png`);
  const t0 = Date.now();
  fs.writeFileSync(file, png, { mode: 0o600 });
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
        env: { ...process.env, FABEL_OCR_IMAGE: file }, windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { p.kill(); reject(new Error('OCR timed out')); }, deps.timeoutMs || TIMEOUT_MS);
      p.stdout.on('data', (d) => { stdout += d; });
      p.stderr.on('data', (d) => { stderr += d; });
      p.on('error', (err) => { clearTimeout(timer); reject(err); });
      p.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`OCR failed: ${String(stderr).split(/\r?\n/).find((l) => l.trim()) || `exit ${code}`}`.slice(0, 300)));
      });
    });
    const text = String(out).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    return { text, lines: text ? text.split('\n').length : 0, ms: Date.now() - t0 };
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

module.exports = { ocrImage };
