#!/bin/sh
set -eu
# Fixture namespaces only. The systemd helper runs outside these containers.
rpc_uid=$HELPER_UID
if test "$LAB_ROLE" = relay; then rpc_uid=0; fi
iptables -P FORWARD DROP
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -A OUTPUT -o lo -p tcp --dport 15888 -m owner ! --uid-owner "$rpc_uid" -j REJECT
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
case "$LAB_ROLE" in
  relay)
    iptables -A INPUT -p tcp --dport 11011 -s 172.31.10.10 -j ACCEPT
    iptables -A INPUT -p tcp --dport 11011 -s 172.31.20.10 -j ACCEPT
    exec /usr/local/bin/easytier-core --disable-env-parsing --config-file /etc/easytier/node.toml --rpc-portal 127.0.0.1:15888 --console-log-level warn
    ;;
  cn)
    iptables -A OUTPUT -o eth0 -p tcp -d 172.31.10.2 --dport 11011 -m owner --uid-owner "$HELPER_UID" -j ACCEPT
    iptables -A OUTPUT -o awtun -p tcp -d 10.126.10.2 --dport 8443 -j ACCEPT
    ;;
  us)
    iptables -A OUTPUT -o eth0 -p tcp -d 172.31.20.2 --dport 11011 -m owner --uid-owner "$HELPER_UID" -j ACCEPT
    iptables -A INPUT -i awtun -p tcp -s 10.126.10.1 --dport 8443 -j ACCEPT
    ;;
  *) exit 78 ;;
esac
# Keep the fixture network namespace alive; it has no EasyTier process of its own.
exec /usr/bin/sleep infinity
