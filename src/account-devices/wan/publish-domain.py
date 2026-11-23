"""Publish the isolated services on a dedicated Nginx hostname with a renewable certificate."""
import os
from pathlib import Path
import subprocess
import sys

from wan_endpoint import endpoint

host, is_domain = endpoint(sys.argv[1])
certbot = Path(sys.argv[2])
if os.geteuid() != 0 or not is_domain or not certbot.is_absolute() or not os.access(certbot, os.X_OK):
    raise SystemExit('Run as root with a DNS hostname and the installed Certbot executable')
if not Path('/etc/anywhere-wan/ca.crt').is_file():
    raise SystemExit('Install the private service before publishing its domain')

site = Path('/etc/nginx/conf.d/anywhere-wan-domain.conf')
header = '# Managed for the Anywhere WAN test service.'
if site.exists() and not site.read_text().startswith(header+'\n'):
    raise SystemExit('The Nginx configuration is already owned by another service')
webroot = Path('/var/www/anywhere-wan-acme')
(webroot / '.well-known/acme-challenge').mkdir(mode=0o755, parents=True, exist_ok=True)
units = Path('/etc/systemd/system')


def run(*args):
    subprocess.run(args, check=True)


def activate(config):
    previous = site.read_text() if site.exists() else None
    if config == previous:
        return
    tmp = site.with_suffix('.next')
    tmp.write_text(config)
    tmp.chmod(0o644)
    tmp.replace(site)
    try:
        run('/usr/sbin/nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    except BaseException:
        if previous is None:
            site.unlink()
        else:
            tmp.write_text(previous)
            tmp.chmod(0o644)
            tmp.replace(site)
        raise


if not site.exists():
    activate(f'''{header}
server {{
    listen 80;
    server_name {host};
    location ^~ /.well-known/acme-challenge/ {{
        root {webroot};
        try_files $uri =404;
    }}
    location / {{ return 404; }}
}}
''')
run(certbot, 'certonly', '--non-interactive', '--no-directory-hooks', '--keep-until-expiring',
    '--key-type', 'ecdsa', '--cert-name', host, '--webroot', '-w', webroot, '-d', host)
template = Path(__file__).with_name('domain.nginx.conf.in').read_text()
activate(template.replace('@DOMAIN@', host))

name = 'anywhere-wan-domain-renew'
service = units / (name+'.service')
timer = units / (name+'.timer')
service.write_text(f'''[Unit]
Description=Renew the Anywhere WAN test domain certificate
[Service]
Type=oneshot
ExecStart={certbot} renew --cert-name {host} --no-directory-hooks --quiet --deploy-hook "/usr/bin/systemctl reload nginx"
''')
timer.write_text(f'''[Unit]
Description=Check the Anywhere WAN test domain certificate twice daily
[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=30m
Persistent=true
[Install]
WantedBy=timers.target
''')
run('systemctl', 'daemon-reload')
run('systemd-analyze', 'verify', service, timer)
run('systemctl', 'enable', '--now', timer.name)
