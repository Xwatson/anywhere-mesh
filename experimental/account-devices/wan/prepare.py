"""Create new, owner-only test identities. The server receives only server.toml and account bootstrap input."""
import base64, ipaddress, json, os, secrets, sys, uuid
from pathlib import Path
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

os.umask(0o077)
dest=Path(sys.argv[1]);public=str(ipaddress.IPv4Address(sys.argv[2]))
dest.mkdir(mode=0o700,exist_ok=False)
secret=secrets.token_urlsafe(32)
keys={}
for role in ('server','client'):
    key=X25519PrivateKey.generate()
    keys[role]=[base64.b64encode(data).decode() for data in [
        key.private_bytes(serialization.Encoding.Raw,serialization.PrivateFormat.Raw,serialization.NoEncryption()),
        key.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)]]
for role,addr in [('server','2'),('client','1')]:
    lines=['hostname = "wan-'+role+'"','instance_name = "wan-'+role+'"','instance_id = "'+str(uuid.uuid4())+'"',
           'dhcp = false','ipv4 = "10.203.73.'+addr+'/24"',
           'listeners = '+('["wss://127.0.0.1:31483/"]' if role=='server' else '[]'),
           'stun_servers = []','stun_servers_v6 = []','[network_identity]','network_name = "anywhere-wan-test"',
           'network_secret = "'+secret+'"','[secure_mode]','enabled = true',
           'local_private_key = "'+keys[role][0]+'"','local_public_key = "'+keys[role][1]+'"']
    if role=='client':
        lines+=['[[peer]]','uri = "wss://'+public+':31483/"','peer_public_key = "'+keys['server'][1]+'"']
    lines+=['[flags]','dev_name = "awwan0"','default_protocol = "wss"','enable_encryption = true',
            'enable_ipv6 = false','disable_p2p = true','need_p2p = false','disable_udp_hole_punching = true',
            'disable_tcp_hole_punching = true','disable_sym_hole_punching = true','disable_upnp = true',
            'enable_kcp_proxy = false','disable_kcp_input = true','disable_relay_kcp = true',
            'enable_quic_proxy = false','disable_quic_input = true','disable_relay_quic = true',
            'accept_dns = false','enable_exit_node = false','private_mode = true','relay_network_whitelist = "anywhere-wan-test"',
            'multi_thread = false','bind_device = false','no_tun = false']
    (dest/(role+'.toml')).write_text('\n'.join(lines)+'\n')
if '--network-only' not in sys.argv[3:]:
    accounts=[{'username':u,'password':secrets.token_urlsafe(24),'isAdmin':u=='lab-admin'} for u in ['lab-admin','lab-coder','lab-other']]
    (dest/'accounts.json').write_text(json.dumps(accounts,indent=2)+'\n')
