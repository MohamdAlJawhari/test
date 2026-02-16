$ErrorActionPreference = "Stop"

Write-Host "== WhatsApp Sender: Windows build (PyInstaller) =="

$pythonCmd = $null
if (Get-Command python -ErrorAction SilentlyContinue) {
  $pythonCmd = "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  $pythonCmd = "py"
}

if (-not $pythonCmd) {
  throw "Python is not available (neither 'python' nor 'py' was found). Install Python and try again."
}

& $pythonCmd -m pip install -r requirements.txt
& $pythonCmd -m pip install pyinstaller

$iconArgs = @()
if (Test-Path "static\\broadcast.ico") {
  $iconArgs = @("--icon", "static\\broadcast.ico")
} else {
  Write-Host "Note: static\\broadcast.ico not found; building without an .exe icon."
  Write-Host "      Convert static\\broadcast.svg to .ico and re-run if you want an app icon."
}

& $pythonCmd -m PyInstaller `
  --noconfirm `
  --clean `
  --name "WhatsAppSender" `
  --onedir `
  @iconArgs `
  --add-data "templates;templates" `
  --add-data "static;static" `
  --add-data "template.txt;." `
  main.py

$distDir = Join-Path "dist" "WhatsAppSender"
if (-not (Test-Path $distDir)) {
  throw "Build failed: $distDir not found."
}

Copy-Item -Force "index.js" (Join-Path $distDir "index.js")
Copy-Item -Force "package.json" (Join-Path $distDir "package.json")
if (Test-Path "package-lock.json") {
  Copy-Item -Force "package-lock.json" (Join-Path $distDir "package-lock.json")
}

if (Test-Path "node_modules") {
  Write-Host "Copying node_modules (this can take a while)..."
  Copy-Item -Recurse -Force "node_modules" (Join-Path $distDir "node_modules")
} else {
  Write-Host "WARNING: node_modules not found. Run npm install before building, or copy node_modules to $distDir on the target PC."
}

$distNodeExe = Join-Path $distDir "node.exe"
if (-not (Test-Path $distNodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd -and $nodeCmd.Source -and (Test-Path $nodeCmd.Source)) {
    Copy-Item -Force $nodeCmd.Source $distNodeExe
    Write-Host ("Bundled node.exe from: {0}" -f $nodeCmd.Source)
  } else {
    Write-Host "WARNING: Node.js executable not found on this machine. The target PC must have Node installed, or you must copy node.exe next to WhatsAppSender.exe."
  }
}

Write-Host ""
Write-Host "Done."
Write-Host ("Output folder: {0}" -f (Resolve-Path $distDir))
