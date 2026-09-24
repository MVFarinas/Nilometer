# Requirements

What Nilometer needs on your computer before you install it, how to check whether you already
have it, and how to get it if you don't. When everything below checks out, continue with
[Install and use](../README.md#install-and-use) in the README.

| You need | Why | Check with |
|---|---|---|
| **Claude Code**, signed in with a Pro or Max subscription | Nilometer reads what Claude Code records | `claude --version` |
| **Node.js 24** (npm comes with it) | Nilometer is built and run with it | `node --version` prints `v24.` followed by more numbers |
| **git** | To download Nilometer | `git --version` |
| **Windows only: Git for Windows** | It provides Git Bash, which the status line hook and every Nilometer command run in | Git Bash is in the Start menu |

## First, open a terminal

- **macOS:** open **Terminal** (in Applications, then Utilities).
- **Windows:** open **Git Bash** from the Start menu, once Git for Windows is installed (see
  [git](#git) below). Use Git Bash for every command in this guide and in the README, not
  PowerShell or Command Prompt.
- **Linux:** open your terminal.

Run the three checks from the table. If one prints `command not found` (or, on Windows, "is not
recognized"), follow that section below. After installing anything, close the terminal and open a
new one, so it sees the new program.

## Node.js 24

Nilometer needs **Node.js 24** specifically, not just any recent Node.js:

- **Older versions don't work.** Nilometer's database library crashes on them, so `nilometer`
  checks first and stops with a message instead:
  `Nilometer needs Node.js 24, and this is Node.js 22.11.0. ...`
- **Newer versions aren't tested.** Nilometer runs on them and prints a one-line warning each
  time. If anything fails, switch to 24.
- **"The latest Node.js" may not be 24.** nodejs.org also offers newer releases, and
  `brew install node` installs the newest one. Choose 24 on purpose, using one of the two ways
  below.

### The simple way: the official installer (macOS, Windows)

1. Open <https://nodejs.org/dist/latest-v24.x/>. This page always lists the newest release of
   Node.js 24.
2. Download the installer for your computer:
   - **macOS:** the file ending in `.pkg`, for example `node-v24.21.0.pkg`.
   - **Windows:** the file ending in `-x64.msi`, for example `node-v24.21.0-x64.msi`. On a
     Windows computer with an ARM processor, use the one ending in `-arm64.msi`.
3. Open it and accept the defaults.
4. Open a new terminal and run `node --version`. It should start with `v24.`

If it still shows another version, an earlier Node.js install comes first on your computer.
Either remove that one, or use a version manager instead.

### The flexible way: a version manager (macOS, Linux, Windows)

A version manager keeps several Node.js versions side by side and switches between them. Use this
if you already have a different Node.js that other projects need, or if you're on Linux. These
steps use [fnm](https://github.com/Schniz/fnm).

1. **Install fnm:**
   - **macOS:** `brew install fnm`, or `curl -fsSL https://fnm.vercel.app/install | bash`
   - **Linux:** `curl -fsSL https://fnm.vercel.app/install | bash`
   - **Windows:** in PowerShell, `winget install Schniz.fnm`
2. **Let your terminal find it.** Add one line to your shell's settings file, unless the install
   already did (look in the file first):
   - **zsh** (the macOS default), in `~/.zshrc`: `eval "$(fnm env --use-on-cd --shell zsh)"`
   - **bash** (Linux, and Git Bash on Windows), in `~/.bashrc`:
     `eval "$(fnm env --use-on-cd --shell bash)"`
3. **Install Node.js 24** in a new terminal:
   ```sh
   fnm install 24
   fnm default 24
   ```
4. Run `node --version`. It should start with `v24.`

Nilometer's folder contains a `.nvmrc` file that names version 24, so with the line from step 2,
fnm switches to it whenever you're in that folder.

## git

- **macOS:** run `git --version`. If git isn't installed, macOS offers to install the "command
  line developer tools", which include it. Accept, then run `git --version` again.
- **Windows:** install **Git for Windows** from <https://git-scm.com/downloads/win>. The default
  options are fine. It installs both git and **Git Bash**.
- **Linux:** use your package manager, for example `sudo apt install git` on Debian or Ubuntu,
  or `sudo dnf install git` on Fedora.

## Claude Code

Install Claude Code by following Anthropic's guide at <https://code.claude.com/docs/en/setup>.
Then run `claude` once and sign in with a Pro or Max subscription. `claude --version` should print
a version number.

- **Use it in a terminal for full results.** Nilometer's usage-window numbers (headroom, peak,
  burn rate) come from Claude Code's status line, which only runs when Claude Code runs in a
  terminal. The VS Code extension doesn't run it. Its tokens and limit hits are still read from
  Claude Code's logs.
- **Windows:** with Git for Windows installed, Claude Code runs the status line through Git Bash,
  which Nilometer's hook needs. Without Git for Windows, it uses PowerShell, and the hook can't
  run.

## When something goes wrong

| What you see | What it means |
|---|---|
| `node: command not found`, or `npm: command not found` | Node.js isn't installed, or the terminal was open before you installed it. Open a new terminal. |
| `Nilometer needs Node.js 24, and this is Node.js ...` | Your Node.js is older than 24. Install 24 as above. Nothing was changed. |
| `Nilometer is tested on Node.js 24, and this is Node.js ...` | Your Node.js is newer than 24. The command still runs. If it fails, switch to 24. |
| `EBADENGINE` warnings during `npm ci`, on a Node.js 24 older than 24.15 | Harmless: three development tools ask for a newer 24. The install still succeeds. |
| `spawn sh ENOENT`, or `sh` not found, on Windows | The command ran in PowerShell or Command Prompt. Run it in Git Bash. |
| `git: command not found` | Install git as above, then open a new terminal. |
