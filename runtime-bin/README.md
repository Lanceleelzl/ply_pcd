# Prebuilt native workers

This directory contains versioned native workers for users who do not have a C++ toolchain.

- `win32-x64/registration_worker.exe` is built from the source in this repository with the static MSVC runtime.
- `manifest.json` records the worker hash and the native-source fingerprint.
- `pnpm build:native` rebuilds the worker and replaces these files when Visual Studio 2022 is available.

The prebuilt binary is a convenience form of the GPL-3.0-or-later program. Corresponding source is included in this repository.
