# Sixfold for the desktop

The website as an application for Windows, macOS and Linux: the pipeline lab, the three-architecture
lab, the instruction workshop and the documentation, with no internet connection needed (only the web
fonts are fetched when online; without them the system fonts are used). It is the same static site the
GitHub Pages workflow publishes, wrapped in [Electron](https://www.electronjs.org/) (a Chromium browser
plus Node.js, packaged as a native app).

## Download

Every release on GitHub has the apps attached (built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)):

| system | file | how to start it |
|---|---|---|
| Windows 10 / 11 | `Sixfold-<version>-win-x64-setup.exe` (installer) or `...-portable.exe` (no install) | double-click |
| macOS 12 or later | `Sixfold-<version>-mac-arm64.dmg` (Apple Silicon) or `...-mac-x64.dmg` (Intel) | open the disk image, drag Sixfold to Applications |
| Linux | `Sixfold-<version>-linux-x86_64.AppImage` or `...-linux-amd64.deb` | `chmod +x Sixfold-*.AppImage && ./Sixfold-*.AppImage`, or `sudo apt install ./Sixfold-*.deb` |

The apps are not code-signed (signing needs paid certificates from Apple and a Windows certificate
authority), so each system asks once whether to trust them:

* **macOS (Gatekeeper):** right-click Sixfold in Applications, choose Open, then Open again. Or in a terminal:
  `xattr -dr com.apple.quarantine /Applications/Sixfold.app`
* **Windows (SmartScreen):** on "Windows protected your PC", click More info, then Run anyway.
* **Linux:** an AppImage needs FUSE (Filesystem in Userspace); if it does not start, run it with
  `--appimage-extract-and-run`, or install the .deb instead.

## Run and build it yourself

Needs Node.js 22 (with npm). From the repository root:

```bash
cd desktop
npm ci                 # Electron and electron-builder, pinned in package-lock.json
npm start              # copies the site into app-site/ and opens the app
```

Build the installers (they land in `desktop/dist/`). Each system builds its own apps; the release
workflow builds all three on GitHub's Windows, macOS and Linux machines.

```bash
npm run dist:linux     # Sixfold-<version>-linux-x86_64.AppImage and ...-linux-amd64.deb
npm run dist:win       # on Windows: ...-win-x64-setup.exe and ...-win-x64-portable.exe
npm run dist:mac       # on macOS: .dmg and .zip for arm64 and x64
```

Publish a release with all of them attached: raise `version` in `desktop/package.json`, then

```bash
git tag v2.1.0 && git push origin v2.1.0
```

## How it works

* `scripts/stage.mjs` copies the site (`index.html`, `site/`, `web/`, `model/`, `programs/`, `docs/`
  without the silicon layout data, `binary/`, `custom/`) into `app-site/`, which is packed into the app.
* `main.js` serves those files from a private address, `app://sixfold/`. Browsers do not run JavaScript
  modules from `file://` pages; a registered "standard, secure" scheme behaves like an https site, so
  every module loads exactly as on GitHub Pages.
* Safety: pages run with context isolation and the Chromium sandbox, without Node.js access. Links to
  other sites (GitHub, references) open in your normal browser; the app window only shows its own pages.
* The Go menu (Ctrl or Cmd + 1 to 4) jumps between the home page, the pipeline lab, the
  three-architecture lab and the instruction workshop. The window remembers its size.

### Smoke test

`SIXFOLD_SMOKE=1` opens each main page without showing a window, waits for its modules to run, and prints
a JSON (JavaScript Object Notation) report: the title, and every console error or failed file load.
It exits with 0 when every page is clean. The release workflow runs it on Linux before building.

```bash
npm run stage
SIXFOLD_SMOKE=1 npx electron .                                       # all pages
SIXFOLD_SMOKE=1 SIXFOLD_SMOKE_PAGES=lab,isa SIXFOLD_SMOKE_OUT=r.json npx electron .
# on a Linux machine with no display: xvfb-run -a npx electron . --no-sandbox
```
