# Halo: Combat Evolved for Linux, Windows and Android

> This repository is the source-only home of the independently hosted browser
> version at [mitchellhynes.com/halo](https://mitchellhynes.com/halo). It does
> not include proprietary Halo game data, generated web builds, deployment
> secrets, or local agent/workspace material. CI enforces those boundaries.

This project is a port of the Halo: Combat Evolved decompilation to Linux,
Windows and Android. The decompilation is of the Xbox build 2342
(`cachebeta.exe`, SHA-256
`4cc87b45f721270392a96f1674ed2b5cd4a7bb4355faeab4531d1cf1884d9520`).

<img width="1289" height="995" alt="The game on Linux" src="https://github.com/user-attachments/assets/0d3ad50f-f8b8-46cf-aef8-e3661da2a7d7" />

The port starts from the decompilation of [bnunu/halo-1](https://github.com/bnunu/halo-1).
That project is a fork of [punpckhdq/halo](https://github.com/punpckhdq/halo).

## Download

GitHub Actions builds the game for each commit. These links download the
builds of the latest release:

| Platform | Release | Debug |
| --- | --- | --- |
| Linux | [halo-linux-release.zip](https://github.com/cybersecurity/halo-ce-universal/releases/latest/download/halo-linux-release.zip) | [halo-linux-debug.zip](https://github.com/cybersecurity/halo-ce-universal/releases/latest/download/halo-linux-debug.zip) |
| Windows | [halo-windows-release.zip](https://github.com/cybersecurity/halo-ce-universal/releases/latest/download/halo-windows-release.zip) | [halo-windows-debug.zip](https://github.com/cybersecurity/halo-ce-universal/releases/latest/download/halo-windows-debug.zip) |
| Android | [halo-android-release.zip](https://github.com/cybersecurity/halo-ce-universal/releases/latest/download/halo-android-release.zip) | [halo-android-debug.zip](https://github.com/cybersecurity/halo-ce-universal/releases/latest/download/halo-android-debug.zip) |

Use the release build to play. The debug build stops at the first failed
assertion and writes it to the log. Use the debug build to find and report
problems.

The game updates itself. At start-up it looks for a newer release, and asks
if you want to install it. Refer to "Updates" in
[port/linux/README.md](port/linux/README.md#updates).

Each build of the `main` branch that passes on all three platforms is a new
release. The [Releases](https://github.com/cybersecurity/halo-ce-universal/releases)
page keeps the last five releases. If the latest build has a problem, get
an older build from that page.

## Game data

The port does not include the game data. Make an Xbox disc image (`.xiso` or
`.iso`) from your own copy of Halo: Combat Evolved. All versions of the game
operate. For disc-ripping instructions, visit
[discord.gg/DQRgPUq6B8](https://discord.gg/DQRgPUq6B8).

On Linux and Windows:

1. Start the game.
2. At the first start, the game asks for the disc image. Select it.
3. The game extracts the `maps/` folder next to the executable. Then the
   game starts.

On Android:

1. Extract the `maps/` folder with the Linux or Windows version.
2. Copy the `maps/` folder to the phone.
3. Start the app and select the folder in the folder picker. The app
   copies the data. Refer to [port/android/README.md](port/android/README.md).

### Play in a browser (experimental)

The public multiplayer build is available at
[mitchellhynes.com/halo](https://mitchellhynes.com/halo).
To comply with copyright law and respect the original Halo CE decompilation team, the site
does not host or transmit Halo game data. On first use, choose an XISO made from
your own Xbox copy. The browser validates it locally, copies only the required
maps to origin-private storage in small chunks, and then reads those local files
on demand. The XISO never leaves your device.

To play with friends:

1. Select **Play online**, choose the map and mode, then create a private lobby.
2. Copy the invite link and send the same link to up to 127 friends.
3. Each friend opens the link and Halo joins the lobby automatically. The host
   starts the game when everyone is ready.

Audio starts muted. Everyone needs a current desktop browser with WebGL 2,
WebAssembly threads, WebRTC, and cross-origin isolation support.

The signaling Worker deploys from GitHub Actions after its tests pass. Generated
browser executables and game data are deliberately excluded from Git history;
the executable is built by the deployment pipeline and each player supplies
their own local game data. See
[docs/telemetry.md](docs/telemetry.md) for performance and TURN operations.

### Build the browser version on macOS

Install Ninja and an [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html).
The launcher finds `emcc` on `PATH`, or an SDK installed at `build/emsdk`.
Then run this from the repository root:

```sh
python3 tools/web_run.py --iso "$HOME/Downloads/Halo.iso"
```

The first run extracts the disc's `maps/` folder, builds the WebAssembly game,
starts the required local server, and opens Halo in the default browser. After
that, `python3 tools/web_run.py` is enough. Press Control-C in Terminal to stop
the server. Chrome is recommended; the browser must support WebGL 2, WebAssembly
threads, and cross-origin isolation.

## Platforms

Each platform has its own instructions:

| Platform | Instructions |
| --- | --- |
| Linux (32-bit x86 executable, OpenGL 4.5, SDL3) | [port/linux/README.md](port/linux/README.md) |
| Windows (32-bit x86 executable, OpenGL 4.5, SDL3) | [port/windows/README.md](port/windows/README.md) |
| Android (arm64 app, OpenGL ES 3, SDL3) | [port/android/README.md](port/android/README.md) |
| Browser (WebAssembly, WebGL 2, SDL3; experimental) | See "Play in a browser" above |

The Linux README also gives the controls, the settings and the multiplayer
functions. These are almost the same on all platforms.

## Multiplayer

The game can play system link games on a local network and on the internet:

- A system link game can have up to 128 players on up to 128 machines.
- Linux, Windows and Android machines can play in the same game.
- The browser build supports one host and up to 127 friends per reusable private
  invite link. The Cloudflare service exchanges connection metadata; gameplay
  travels directly between each friend and the host when their networks permit it.
- Native builds can use an invite link without a server from this project.
- The default netcode is new. Each machine moves its own player at once,
  and the host makes the decisions for the game. Refer to
  [port/linux/NETCODE.md](port/linux/NETCODE.md).

## Build the game

You do not need the Xbox SDK. The port supplies the SDK declarations that
the game uses. Refer to [port/include/xdk](port/include/xdk/README.md).

To build the game:

1. Install Python and [ninja](https://ninja-build.org/).
2. Install the tools for your platform. Refer to the README for the
   platform.
3. In the root folder of the repository, enter `python configure.py`.
4. Enter `ninja` with the target for the platform:

| Target | Result |
| --- | --- |
| `ninja linux` | `build/linux/halo` |
| `ninja windows` (on Windows) | `build/windows/halo.exe` and `SDL3.dll` |
| `ninja android_apk` | `port/android/app/build/outputs/apk/debug/app-debug.apk` |
| `ninja web` | `build/web/halo.html`, served with `python3 tools/web_serve.py` |

If you enter `ninja` without a target, ninja builds the game for the
computer that you use.

`tools/ci_build.py` makes the same builds as GitHub Actions. For example,
enter `python tools/ci_build.py linux release`.

### Build options

Give these options to `configure.py`:

| Option | Result |
| --- | --- |
| (none) | A debug build. A failed assertion stops the game. |
| `--release` | A release build. The game does not examine assertions, as in the retail game. |
| `--portable` | The Linux and Windows builds operate on all x86-64 processors. Use this option for builds that you give to other persons. |
| `--lto=thin`, `--lto=off` | Less link-time optimization. The link is faster. |
| `--pgo=off` | No profile-guided optimization. |
| `--pgo=train` | Records a new optimization profile. Refer to "Optimization profiles". |

Without `--portable`, the Linux and Windows builds use all the instructions
of the processor that builds them (`-march=native`). Such a build does not
always start on a different computer.

### Optimization profiles

The builds use profiles of the game to optimize the code:

- `pgo/halo_linux.profdata` for Linux and Android.
- `pgo/halo_windows.profdata` for Windows.

The profiles need clang 22 or later. With an older clang, the builds do not
use the profiles.

To record a new profile:

1. Delete the profile.
2. Enter `python configure.py --pgo=train`.
3. Enter `ninja linux` or `ninja windows`.

The build then plays the main menu and the first minute of each campaign
level. This procedure continues for approximately 15 minutes. The game
data must be in `assets/`.

### The byte-matching build

The original project also has a byte-matching build. That build compiles
the game with the compiler of the Xbox SDK and compares the result with
`cachebeta.exe`. This project does not generate that build, because the
Xbox SDK is not free to distribute. The sources of that build are not
changed. To use the build again, set `SolutionConfig.matching` in
`tools/project_x86.py`. You must also have the Xbox SDK in `xbox/` and
`cachebeta.exe` in the root folder.
