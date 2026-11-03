# Publishing: GitHub, the website, and the desktop apps

Three things live on GitHub: the repository, the website (GitHub Pages, built by
[`.github/workflows/pages.yml`](../.github/workflows/pages.yml)), and the desktop apps (GitHub Releases,
built by [`.github/workflows/release.yml`](../.github/workflows/release.yml)). Commands are for Ubuntu or
Windows Subsystem for Linux (WSL), with an SSH (Secure Shell) key already set up for GitHub.

## 1. Update the repository

From a fresh copy of the repository (a zip of it, or a clone):

```bash
cd ~/sixfold-cpu
git status                       # what changed
git log --oneline -3             # the newest commits
git push git@github.com:Normansrule/sixfold-cpu.git main
```

If the push is refused because GitHub has commits you do not have, fetch them first and push again:
`git pull --rebase git@github.com:Normansrule/sixfold-cpu.git main`.

## 2. Turn on the website (once)

The site is built by a GitHub Actions workflow, so Pages must use "GitHub Actions" as its source, not a branch.

In the browser: the repository on GitHub, then **Settings**, **Pages**, and under **Build and deployment**,
**Source: GitHub Actions**.

Or with the GitHub command-line tool (`gh`, https://cli.github.com, signed in with `gh auth login`):

```bash
gh api -X POST repos/Normansrule/sixfold-cpu/pages -f build_type=workflow     # first time
gh api -X PUT  repos/Normansrule/sixfold-cpu/pages -f build_type=workflow     # if Pages was already on (from a branch)
gh workflow run pages.yml -R Normansrule/sixfold-cpu                          # deploy now, without waiting for a push
```

After that, every push to `main` deploys the site in about a minute to
**https://normansrule.github.io/sixfold-cpu/**. Check a deployment:

```bash
gh run list -R Normansrule/sixfold-cpu --workflow pages.yml --limit 3          # the latest runs and their status
gh api repos/Normansrule/sixfold-cpu/pages --jq '.html_url, .build_type, .status'
```

A missing page shows the site's own [404 page](../404.html), with links back to the home page and the labs.

## 3. Release the desktop apps

Pushing a version tag builds Windows, macOS and Linux apps on GitHub's machines and attaches them to a
GitHub Release; the site's download section links to the newest one automatically.

```bash
git tag v2.2.0
git push git@github.com:Normansrule/sixfold-cpu.git v2.2.0
gh run watch -R Normansrule/sixfold-cpu $(gh run list -R Normansrule/sixfold-cpu --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Use a new version number for every release (the tag must not exist yet), and match it in
`desktop/package.json` (`"version"`) so the file names agree. The apps are not code-signed: on Windows,
SmartScreen needs **More info**, then **Run anyway**; on macOS, right-click the app, then **Open**.

## 4. What continuous integration checks on every push

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml): Verilator lint, every program on the RTL against
the model (both builds, predictor on and off), the cycle equation, the FPGA computer over its simulated
serial port, the board loader against a virtual board, the three instruction sets against the Unicorn
emulator, random custom instructions, accessibility of every page (`make a11y`), that every generated
page and picture is current, and that every documentation link resolves. A red mark on a commit names
the step that failed; `make <that step>` reproduces it locally.
