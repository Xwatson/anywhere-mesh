# EasyTier provenance

This Linux prototype supervises unmodified EasyTier v2.6.4 executables as separate processes. The binaries are installed from the separately verified lab download; they are not committed into this repository.

- Upstream release: https://github.com/EasyTier/EasyTier/releases/tag/v2.6.4
- Corresponding source: https://github.com/EasyTier/EasyTier/tree/v2.6.4
- Source archive: https://github.com/EasyTier/EasyTier/archive/refs/tags/v2.6.4.tar.gz
- License: GNU LGPL version 3; copies of LGPL v3 and GPL v3 are in `licenses/` and installed under `/usr/share/doc/anywhere-network/` in the guest.
- Binary modifications: none.
- Linux x86_64 archive SHA-256: `61b659eaedba658fa66fe47d17e1426cdd77e5d02fa15fed447bb4357c09dfd6`.
- `easytier-core` SHA-256: `35b854e0c5853c02733870488c977200f6aa06d09c08d5dc7f9f9e150e7be8d5`.
- `easytier-cli` SHA-256: `8da66644ec50dcf618fccf76780991f52dfbe2939797abc0efe0ef4d4c4d3383`.

An administrator can replace the installed executables and update the fixed profile hashes. Client requests cannot change them. Public installer packaging and its source distribution process are outside this lab prototype.
