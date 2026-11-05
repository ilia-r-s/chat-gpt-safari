#!/usr/bin/env python3
"""Package PNG icon representations without extra image libraries."""
from pathlib import Path
import struct

root = Path(__file__).resolve().parents[1]
representations = {"icp4": 16, "icp5": 32, "icp6": 64, "ic07": 128, "ic08": 256, "ic09": 512, "ic10": 1024}
chunks = []
for kind, size in representations.items():
    filename = f"icon_{size}x{size}.png" if size not in (64, 1024) else f"icon_{size // 2}x{size // 2}@2x.png"
    data = (root / "build/AppIcon.iconset" / filename).read_bytes()
    assert data.startswith(b"\x89PNG\r\n\x1a\n") and struct.unpack(">II", data[16:24]) == (size, size)
    chunks.append(kind.encode() + struct.pack(">I", len(data) + 8) + data)
payload = b"".join(chunks)
(root / "native/App/AppIcon.icns").write_bytes(b"icns" + struct.pack(">I", len(payload) + 8) + payload)
