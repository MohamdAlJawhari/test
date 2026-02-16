# WhatsApp Sender

Local desktop-style app for sending WhatsApp text/media messages through a web UI.

It runs two local services:

- Python (Flask/Waitress) for the UI and app orchestration
- Node.js (`@wppconnect-team/wppconnect`) for WhatsApp Web automation

## Requirements

- Python 3.10+ (recommended)
- Node.js + npm
- Windows (for `.exe` build script)

## Local Development Run

1. Install Node dependencies:

```powershell
npm install
```

2. Install Python dependencies:

```powershell
pip install -r requirements.txt
```

3. Start the app:

```powershell
python main.py
```

The app opens in your browser automatically.

## Build Windows EXE

Use the provided script:

```powershell
.\build_windows.ps1
```

Output folder:

- `dist\WhatsAppSender\`

The build script also:

- Bundles `node.exe` (if available on build machine)
- Copies `node_modules`
- Installs Puppeteer Chrome runtime into:
  `dist\WhatsAppSender\puppeteer-cache`
- Builds without UPX (`--noupx`) to reduce antivirus false positives

## Distribute to Another PC

Zip and send the entire folder:

- `dist\WhatsAppSender\`

On target machine:

1. Extract the full folder
2. Run `WhatsAppSender.exe`

Do not send only the `.exe` file by itself.

## Troubleshooting

### 1) `Could not find Chrome (ver. ...)`

Cause: Puppeteer browser runtime was not packaged.

Fix:

1. Rebuild with internet access on build machine: `.\build_windows.ps1`
2. Verify folder exists: `dist\WhatsAppSender\puppeteer-cache`
3. Re-copy the full `dist\WhatsAppSender\` folder

### 2) EXE disappears / Defender says threat found

Cause: Common false positive for unsigned PyInstaller apps.

Fix for testing:

1. Open Windows Security -> Protection history
2. Restore/Allow the quarantined file
3. Add exclusion for release folder if needed

Production fix:

- Code-sign the executable (prefer EV certificate)
- Submit false-positive sample/hash to Microsoft

### 3) `browser is already running ... userDataDir ...`

Cause: previous background instance still holding session profile lock.

Fix:

1. Close old `WhatsAppSender.exe` / `node.exe` processes
2. Start app again

Note: app includes automatic backend shutdown when UI tabs are closed; allow a short delay before relaunch.

## Main Project Files

- `main.py`: Python entrypoint (UI server + Node lifecycle)
- `index.js`: Node WhatsApp API service
- `app_core/`: Python business logic and routes
- `templates/`, `static/`: UI files
- `build_windows.ps1`: Windows build script

