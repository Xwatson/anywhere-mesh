"""Create this Windows lab peer once from the existing domain deployment."""
import base64
import json
import os
from pathlib import Path
import sys
import tomllib
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

source = tomllib.loads(Path(sys.argv[1]).read_text())
peer, = source["peer"]
if not peer["uri"].startswith("wss://") or not peer["uri"].endswith("/easytier") or not source["secure_mode"]["enabled"]:
    raise SystemExit("Expected the secure WAN domain deployment")

def encode(data):
    return base64.b64encode(data).decode("ascii")

key = X25519PrivateKey.generate()
private = encode(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption()))
public = encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw))
flags = dict(source["flags"], no_tun=True, use_smoltcp=True)
sections = [
    ("", {"hostname": "wan-windows", "instance_name": "wan-windows", "instance_id": str(uuid.uuid4()),
          "dhcp": False, "ipv4": "10.203.73.3/24", "listeners": [], "stun_servers": [], "stun_servers_v6": []}),
    ("[network_identity]", source["network_identity"]),
    ("[secure_mode]", {"enabled": True, "local_private_key": private, "local_public_key": public}),
    ("[[peer]]", peer),
    ("[[port_forward]]", {"bind_addr": "127.0.0.1:31844", "dst_addr": "10.203.73.2:18443", "proto": "tcp"}),
    ("[flags]", flags),
]
os.umask(0o077)
with Path(sys.argv[2]).open("x") as out:
    for header, values in sections:
        print(header, file=out)
        for name, value in values.items():
            print(name, "=", json.dumps(value), file=out)
