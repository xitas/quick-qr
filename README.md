# Quick QR

A simple QR code generator that runs entirely in your browser. Nothing you type is uploaded.

## Features

- **QR types:** text or URL, WiFi, phone number, email and contact card (vCard)
- **Live preview** that updates as you type
- **Customization:** foreground and background colors, size from 128 to 1024 px, and error correction level (L, M, Q or H)
- **Export:** download as PNG or SVG, or copy the image to the clipboard
- **History:** the last 10 codes are saved in your browser; click one to reload it
- **Checks:** inline messages for invalid input, and a warning when colors have too little contrast to scan
- **Light and dark mode**, keyboard navigation and screen-reader labels

## Run locally

Open `index.html` in a browser. There is no build step.

If **Copy image** is blocked when the page is opened as a local file, serve the folder instead:

```sh
npx serve .
# or
python -m http.server
```

## Deploy

- **GitHub Pages:** push the repo, open **Settings → Pages**, and deploy from your branch with the root folder `/`.
- **Netlify:** drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop), or import the repo with no build command and `/` as the publish directory.

## Offline use

The QR library ([qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)) loads from cdnjs. To use the app offline, download [`qrcode.min.js`](https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js) into this folder and point the `<script>` tag in `index.html` to it.

## Files

| File         | Purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `index.html` | Page markup                                              |
| `style.css`  | Styles and the light and dark themes                     |
| `app.js`     | Building the QR content, validation, rendering, history  |

## Privacy

History is stored in your browser's `localStorage` and never leaves your device. It includes WiFi passwords in plain text, so use **Clear history** on shared computers.
