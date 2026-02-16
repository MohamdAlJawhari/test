# Build a Windows `.exe` (portable folder)

This project is a local web app:
- Python runs the UI server (Flask in dev, **Waitress** in production).
- Node.js runs the WhatsApp API (`index.js`).

## 1) Requirements (build machine)

- Python installed and available as `python`
- Node.js + npm (needed to install Node dependencies / create `node_modules`)

## 2) Prepare Node dependencies

```powershell
npm install
```

## 3) (Optional) App icon

Windows `.exe` icons need an `.ico` file.

- Convert `static\broadcast.svg` to `static\broadcast.ico`
- Then the build script will pick it up automatically

## 4) Build

```powershell
.\build_windows.ps1
```

Output: `dist\WhatsAppSender\`

## 5) Send to another PC

Zip and send the whole folder: `dist\WhatsAppSender\`

On the target PC, run: `WhatsAppSender.exe`

If the target PC does **not** have Node installed:
- the build script tries to bundle `node.exe` automatically into `dist\WhatsAppSender\node.exe`
- if it is missing, install Node.js on the target PC or copy a `node.exe` next to `WhatsAppSender.exe`

## Bundled Chrome runtime (Puppeteer)

The build script now installs the required Puppeteer Chrome into:

- `dist\WhatsAppSender\puppeteer-cache\`

This avoids target-machine errors like:

- `Could not find Chrome (ver. ...)`

If build fails at the Chrome install step, ensure the build machine has internet access and run:

```powershell
.\build_windows.ps1
```

## Defender / SmartScreen notes

If Windows Defender removes `WhatsAppSender.exe`, it is usually a **false positive** on unsigned PyInstaller apps.

This project now builds with `--noupx` (no binary packing), which reduces false detections, but for production distribution you should still:

1. Code-sign the executable (ideally EV code-signing certificate).
2. Submit the built file hash/sample to Microsoft Security Intelligence as a false positive for reputation tuning.
3. Keep stable release filenames and versioning so reputation can accumulate.
4. For internal testing only, add a Defender exclusion for the release folder on the target machine.

## Notes

- To start fresh on a new PC, do **not** copy `tokens\` (WhatsApp session) or your uploaded contacts under `data\contacts_uploads\`.
- Dev mode (shows Flask dev warning): `setx FLASK_DEBUG 1` then re-open terminal and run again.
