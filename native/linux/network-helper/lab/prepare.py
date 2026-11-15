#!/usr/bin/env python3
"""Generate isolated lab identities and a Docker topology; never starts Docker."""
import base64
import datetime
import ipaddress
import json
import os
from pathlib import Path
import secrets
import uuid
import argparse
import shutil

import yaml
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, x25519
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--baseline', required=True)
a = parser.parse_args()
lab = Path(a.output).resolve()
baseline = Path(a.baseline).resolve()
if lab == baseline or lab.exists():
    raise SystemExit('Choose a new fixture directory; existing identities are never overwritten.')
lab.mkdir(mode=0o700)
for directory in ['config/topology', 'secrets', 'artifacts']:
    (lab/directory).mkdir(parents=True, mode=0o700, exist_ok=True)
shutil.copyfile(baseline/'artifacts/python-image-lock.json', lab/'artifacts/python-image-lock.json')
top = lab / "config/topology"
runtime = top / "runtime"
if runtime.exists():
    raise SystemExit("Identities already exist; refusing to rotate them implicitly.")
os.umask(0o077)
runtime.mkdir(mode=0o700)
now = datetime.datetime.now(datetime.timezone.utc)
name = lambda value: x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, value)])
ca_key = ed25519.Ed25519PrivateKey.generate()
ca_name = name("Anywhere Lab Environment CA")
ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
      .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
      .not_valid_before(now-datetime.timedelta(minutes=5))
      .not_valid_after(now+datetime.timedelta(days=365))
      .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
      .sign(ca_key, algorithm=None))
(lab/"secrets/environment-ca.key").write_bytes(ca_key.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(runtime/"ca.crt").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
for role in ("cn", "us"):
    key = ed25519.Ed25519PrivateKey.generate()
    builder = (x509.CertificateBuilder().subject_name(name(role+"-mock"))
        .issuer_name(ca_name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now-datetime.timedelta(minutes=5))
        .not_valid_after(now+datetime.timedelta(days=90))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([
            ExtendedKeyUsageOID.SERVER_AUTH if role=="us" else ExtendedKeyUsageOID.CLIENT_AUTH]), critical=False))
    if role=="us":
        builder=builder.add_extension(x509.SubjectAlternativeName([
            x509.IPAddress(ipaddress.ip_address("10.126.10.2")), x509.DNSName("us-mock")]), critical=False)
    cert=builder.sign(ca_key, algorithm=None)
    (runtime/(role+".crt")).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (runtime/(role+".key")).write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))

keys={}
for role in ("relay","cn","us"):
    key=x25519.X25519PrivateKey.generate()
    keys[role]={
        "private":base64.b64encode(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode(),
        "public":base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()}
network_secret=secrets.token_urlsafe(32)
for role in keys:
    lines=[
        'hostname = "'+role+'-helper-lab"',
        'instance_name = "anywhere-lab-'+role+'"',
        'instance_id = "'+str(uuid.uuid4())+'"',
        'dhcp = false',
        'listeners = ["wss://0.0.0.0:11011/"]' if role=="relay" else 'listeners = []',
        'stun_servers = []', 'stun_servers_v6 = []']
    if role!="relay":
        lines += ['ipv4 = "10.126.10.'+("1" if role=="cn" else "2")+'/24"']
    lines += ['[network_identity]', 'network_name = "anywhere-helper-a"',
              'network_secret = "'+network_secret+'"', '[secure_mode]', 'enabled = true',
              'local_private_key = "'+keys[role]["private"]+'"',
              'local_public_key = "'+keys[role]["public"]+'"']
    if role!="relay":
        relay_ip="172.31.10.2" if role=="cn" else "172.31.20.2"
        lines+=['[[peer]]', 'uri = "wss://'+relay_ip+':11011/"',
                'peer_public_key = "'+keys["relay"]["public"]+'"']
    lines+=['[flags]', 'default_protocol = "wss"', 'dev_name = "awtun"',
            'enable_encryption = true', 'encryption_algorithm = "aes-gcm"',
            'enable_ipv6 = false', 'disable_p2p = true', 'need_p2p = false',
            'disable_udp_hole_punching = true', 'disable_tcp_hole_punching = true',
            'disable_sym_hole_punching = true', 'disable_upnp = true',
            'enable_kcp_proxy = false', 'disable_kcp_input = true', 'disable_relay_kcp = true',
            'enable_quic_proxy = false', 'disable_quic_input = true', 'disable_relay_quic = true',
            'accept_dns = false', 'enable_exit_node = false', 'private_mode = true',
            'relay_network_whitelist = "anywhere-helper-a"',
            'multi_thread = false', 'bind_device = false',
            'no_tun = '+("true" if role=="relay" else "false")]
    (runtime/(role+".toml")).write_text("\n".join(lines)+"\n")

# Runtime files are individually bind-mounted. Readability permits the ordinary
# business UID and cap-dropped root sidecars; the enclosing host directory is 0700.
for p in runtime.iterdir():
    p.chmod(0o444)

limits=dict(read_only=True, restart="no", pids_limit=96, cpus=0.5,
            mem_limit="256m", security_opt=["no-new-privileges:true"],
            cap_drop=["ALL"], tmpfs=["/tmp:size=16m,mode=1777"],
            logging={"driver":"local","options":{"max-size":"5m","max-file":"2"}})
services={}
for role in keys:
    spec=dict(limits)
    spec.update(image="sha256:504c7dee6f93249b73e401a50fbe0b153768bbcf031357a8a13edb71f3060d5b",
        platform="linux/amd64", cap_add=["NET_ADMIN","NET_RAW"],
        environment={"LAB_ROLE":role,"HELPER_UID":"${HELPER_UID:?set HELPER_UID}"},
        entrypoint=["/usr/local/bin/native-net-entrypoint"],
        volumes=["./runtime/"+role+".toml:/etc/easytier/node.toml:ro", "./native-net-entrypoint.sh:/usr/local/bin/native-net-entrypoint:ro"],
        sysctls={"net.ipv4.ip_forward":"0","net.ipv6.conf.all.disable_ipv6":"1"})
    if role=="relay":
        spec["networks"]={"cn-underlay":{"ipv4_address":"172.31.10.2"},"us-underlay":{"ipv4_address":"172.31.20.2"}}
    else:
        spec["networks"]={role+"-underlay":{"ipv4_address":"172.31."+("10" if role=="cn" else "20")+".10"}}
        spec["devices"]=["/dev/net/tun:/dev/net/tun"]
        spec["depends_on"]=["relay"]
    services[role]=spec
python_image="python@"+json.loads((lab/"artifacts/python-image-lock.json").read_text())["amd64_digest"]
for role,service in [("us","us-mock"),("cn","cn-probe")]:
    spec=dict(limits)
    spec.update(image=python_image, platform="linux/amd64", user="10001:10001",
                network_mode="service:"+role,depends_on=[role],
                volumes=["./runtime/ca.crt:/certs/ca.crt:ro",
                         "./runtime/"+role+".crt:/certs/"+role+".crt:ro",
                         "./runtime/"+role+".key:/certs/"+role+".key:ro"],
                environment={"PYTHONDONTWRITEBYTECODE":"1","PYTHONUNBUFFERED":"1"})
    if role=="us":
        spec["volumes"]+=["./mock-server.py:/probe/server.py:ro"]
        spec["command"]=["python","/probe/server.py"]
    else:
        spec["volumes"]+=["./probe.py:/probe/probe.py:ro"]
        spec["command"]=["python","-c","import signal; signal.pause()"]
    services[service]=spec
networks={role+"-underlay":{"internal":True,"driver":"bridge","ipam":{"config":[{"subnet":"172.31."+n+".0/24"}]}}
          for role,n in [("cn","10"),("us","20")]}
(top/"compose.yaml").write_text(yaml.safe_dump({"name":"anywhere-helper","services":services,"networks":networks},sort_keys=False))
print("Generated three EasyTier identities, isolated networks and mTLS probes.")

for name in ['probe.py','mock-server.py']:
    shutil.copyfile(baseline/'config/topology'/name, top/name)
    (top/name).chmod(0o444)
shutil.copyfile(Path(__file__).with_name('native-net-entrypoint.sh'), top/'native-net-entrypoint.sh')
(top/'native-net-entrypoint.sh').chmod(0o555)
