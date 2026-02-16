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

## Notes

- To start fresh on a new PC, do **not** copy `tokens\` (WhatsApp session) or your uploaded contacts under `data\contacts_uploads\`.
- Dev mode (shows Flask dev warning): `setx FLASK_DEBUG 1` then re-open terminal and run again.
